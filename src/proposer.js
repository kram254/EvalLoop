'use strict';
/**
 * Fix proposer: reads the scanned candidates, reads the full text of the most
 * relevant files, and asks Sonnet for a UNIFIED DIFF addressing the TOP
 * root-cause pattern (never individual failures), plus a rationale.
 *
 * GUARDRAILS enforced here, not by convention:
 *   1. The proposer never sees traces from the held-out split — only the
 *      cluster summary (name/description/exampleCodes), which is derived from
 *      dev traces only.
 *   2. Requirements (REQUIREMENTS.md) are injected so the fix optimizes for
 *      real goals, not just passing evals.
 *   3. The diff may touch at most config.limits.maxPatchFiles files, and none
 *      of them may match the exclusion patterns (re-validated at apply time).
 */
const fs = require('fs');
const path = require('path');
const { extractJson } = require('./anthropic');
const { scanRepo, buildExcludes } = require('./scanner');

const PROPOSE_SCHEMA = {
  type: 'object',
  properties: {
    rationale: { type: 'string', description: 'Why this change addresses the root-cause pattern systemically (3-6 sentences)' },
    rootCauseFix: { type: 'string', description: 'The root-cause category being addressed, verbatim' },
    changedFiles: { type: 'array', items: { type: 'string' }, description: 'Relative paths of files the diff modifies' },
    diff: { type: 'string', description: 'A valid unified diff (git-style @@ headers) applying the change' },
    riskNotes: { type: 'string', description: 'What could regress and why the regression dataset should catch it' },
    antiCheatChecklist: {
      type: 'object',
      properties: {
        noTestDataInPrompt: { type: 'boolean', description: 'The diff adds no eval answers, dataset items, or held-out examples into prompts' },
        addressesPatternNotInstances: { type: 'boolean', description: 'The change targets the systemic pattern, not specific failed inputs' },
      },
      required: ['noTestDataInPrompt', 'addressesPatternNotInstances'],
      additionalProperties: false,
    },
  },
  required: ['rationale', 'rootCauseFix', 'changedFiles', 'diff', 'riskNotes', 'antiCheatChecklist'],
  additionalProperties: false,
};

function proposeFix({ root, config, topCluster }) {
  const scan = scanRepo(root, config);
  const excludes = buildExcludes(config);

  const readCandidate = (c) => {
    if (excludes.some((re) => re.test(c.relPath))) return null; // hard guardrail
    const abs = path.resolve(root, config.repo.root || '.', c.relPath);
    try {
      return `--- FILE: ${c.relPath} (${c.kind}) ---\n` + fs.readFileSync(abs, 'utf8').slice(0, 12000);
    } catch {
      return null;
    }
  };

  const candidates = [...scan.prompts, ...scan.retrieval, ...scan.tools];
  const fileTexts = candidates.map(readCandidate).filter(Boolean);
  if (!fileTexts.length) {
    throw new Error('Scanner found no eligible prompt/retrieval/tool files. Add files or fix repo.promptHints in evalloop.config.json.');
  }

  // REQUIREMENTS.md: real goals, in the user's words.
  const reqPath = path.resolve(root, 'REQUIREMENTS.md');
  const requirements = fs.existsSync(reqPath) ? fs.readFileSync(reqPath, 'utf8').slice(0, 8000) : '(no REQUIREMENTS.md found — create one so fixes optimize real goals)';

  const clusterSummary = {
    name: topCluster.name,
    description: topCluster.description,
    count: topCluster.count,
    exampleCodes: topCluster.exampleCodes,
    suggestedFixKind: topCluster.suggestedFixKind,
    // NOTE: deliberately NOT including trace ids or raw trace content here.
  };

  return extractJson({
    system:
      'You are a senior engineer fixing an LLM agent\'s SYSTEMIC failure pattern.\n' +
      'You will see: (a) a root-cause cluster summary derived from failed-trace evaluator explanations, ' +
      '(b) REQUIREMENTS.md — the real product goals the agent must serve, and (c) candidate source files.\n' +
      'Produce ONE unified diff that changes prompts, retrieval settings, or tool definitions to address the ' +
      'root-cause PATTERN — never patch for individual failed inputs, never embed test data, eval examples, or ' +
      'held-out content in prompts.\n' +
      'The diff must use standard unified format with @@ -a,b +c,d @@ headers and correct context lines.\n' +
      `Touch at most ${(config.limits && config.limits.maxPatchFiles) || 3} files.\n` +
      'Answer only via the emit_json tool.',
    messages: [
      {
        role: 'user',
        content:
          `ROOT-CAUSE CLUSTER (top priority):\n${JSON.stringify(clusterSummary, null, 2)}\n\n` +
          `REQUIREMENTS.MD:\n${requirements}\n\n` +
          `CANDIDATE FILES:\n\n${fileTexts.join('\n\n')}`,
      },
    ],
    schema: PROPOSE_SCHEMA,
    model: 'sonnet',
    maxTokens: 8192,
  });
}

/** Deterministic offline proposal for --mock mode: a canned, self-consistent diff. */
function mockProposeFix({ root, config, topCluster }) {
  // The dogfood example ships agent/prompt.txt; patch it deterministically.
  const targetRel = 'agent/prompt.txt';
  const abs = path.resolve(root, targetRel);
  const original = fs.readFileSync(abs, 'utf8');
  // Simulate a fix: strengthen the grounding instruction.
  const newOriginal = original.replace(
    'Cite every claim with its source line.',
    'Cite every claim with its source line. Never state numbers, dates, or page references that are not present verbatim in the provided source. If the source does not contain the answer, say so explicitly instead of guessing.'
  );
  const diff = makeUnifiedDiff(targetRel, original, newOriginal);
  return {
    rationale:
      `The top root-cause cluster (${topCluster.name}) shows the model asserting specifics absent from the source. ` +
      'The current prompt asks for citations but never forbids unsourced specifics. Adding an explicit ' +
      'verbatim-only constraint plus an explicit fallback ("say so") addresses the pattern systemically.',
    rootCauseFix: topCluster.name,
    changedFiles: [targetRel],
    diff,
    riskNotes: 'Tightening grounding may cause the model to decline answerable questions; the regression dataset of past passes should catch over-refusal.',
    antiCheatChecklist: { noTestDataInPrompt: true, addressesPatternNotInstances: true },
    _mock: true,
  };
}

/** Minimal unified-diff generator (whole-file hunk) for the mock path. */
function makeUnifiedDiff(relPath, oldText, newText) {
  const oldL = oldText.split('\n');
  const newL = newText.split('\n');
  let i = 0;
  while (i < oldL.length && i < newL.length && oldL[i] === newL[i]) i++;
  let jOld = oldL.length, jNew = newL.length;
  while (jOld > i && jNew > i && oldL[jOld - 1] === newL[jNew - 1]) { jOld--; jNew--; }
  const ctx = 3;
  const start = Math.max(0, i - ctx);
  const lines = [`@@ -${start + 1},${jOld - start} +${start + 1},${jNew - start} @@`];
  for (let k = start; k < i; k++) lines.push(' ' + oldL[k]);
  for (let k = i; k < jOld; k++) lines.push('-' + oldL[k]);
  for (let k = i; k < jNew; k++) lines.push('+' + newL[k]);
  for (let k = jOld; k < Math.min(jOld + ctx, oldL.length); k++) lines.push(' ' + oldL[k]);
  return `--- a/${relPath}\n+++ b/${relPath}\n${lines.join('\n')}`;
}

module.exports = { proposeFix, mockProposeFix, PROPOSE_SCHEMA, makeUnifiedDiff };
