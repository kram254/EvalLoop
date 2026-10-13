'use strict';
/**
 * Clustering pipeline:
 *   1. Open coding  — Haiku labels each evaluator explanation with a concrete
 *      observed failure behavior (one short phrase per trace).
 *   2. Axial coding — Sonnet groups the open codes into a small set of
 *      root-cause categories with counts.
 *   3. Priority     — frequency x user-configured severity, ranked.
 *
 * Output is schema-validated JSON (via forced tool use), persisted to the
 * run directory as clusters.json.
 */
const { extractJson } = require('./anthropic');
const { redactTrace } = require('./adapters');

const OPEN_CODE_SCHEMA = {
  type: 'object',
  properties: {
    code: { type: 'string', description: 'A short phrase (max 10 words) naming the concrete failure behavior observed in the explanation' },
    severityHint: { type: 'number', description: '1-5: how badly this failure misleads or blocks the end user (5 = wrong/harmful answer, 1 = cosmetic)' },
  },
  required: ['code', 'severityHint'],
  additionalProperties: false,
};

const AXIAL_SCHEMA = {
  type: 'object',
  properties: {
    categories: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Root-cause category name, 2-5 words' },
          description: { type: 'string', description: 'One sentence describing the systemic cause' },
          memberTraceIds: { type: 'array', items: { type: 'string' } },
          exampleCodes: { type: 'array', items: { type: 'string' }, description: 'Up to 5 representative open codes' },
          suggestedFixKind: { type: 'string', description: 'prompt | retrieval | tool-definition | data | other' },
        },
        required: ['name', 'description', 'memberTraceIds', 'exampleCodes', 'suggestedFixKind'],
        additionalProperties: false,
      },
    },
  },
  required: ['categories'],
  additionalProperties: false,
};

async function openCode(trace, explanations) {
  return extractJson({
    system:
      'You are a qualitative researcher doing OPEN CODING on LLM-agent failures. ' +
      'Given one failed agent trace and its evaluator explanations, name the CONCRETE behavior that failed ' +
      '(e.g. "cited page number not in source", "omitted required policy element"). Never invent facts not in the explanation. ' +
      'Answer only via the emit_json tool.',
    messages: [
      {
        role: 'user',
        content:
          `INPUT: ${trace.agentInput}\n` +
          `OUTPUT: ${trace.agentOutput ?? '(no output — agent crashed or returned empty)'}\n` +
          `EVALUATOR EXPLANATIONS:\n${explanations}`,
      },
    ],
    schema: OPEN_CODE_SCHEMA,
    model: 'haiku',
    maxTokens: 512,
  });
}

async function axialTrace(traces, codes) {
  const lines = traces.map((t, i) => `${i + 1}. [${t.id}] ${codes[i]}`);
  return extractJson({
    system:
      'You are a qualitative researcher doing AXIAL CODING. You are given open codes from failed LLM-agent traces ' +
      '(with trace ids). Group them into AT MOST 5 root-cause categories that describe SYSTEMIC causes a prompt or ' +
      'retrieval change could address — not one-off incidents. Prefer fewer, broader categories. ' +
      'Every trace id must appear in exactly one category. Answer only via the emit_json tool.',
    messages: [{ role: 'user', content: lines.join('\n') }],
    schema: AXIAL_SCHEMA,
    model: 'sonnet',
    maxTokens: 2048,
  });
}

/**
 * Full pipeline. Returns:
 * { clusters: [{ name, description, count, traceIds, exampleCodes, suggestedFixKind, priority }],
 *   ranked: same sorted desc by priority, top: ranked[0] || null }
 */
async function clusterFailures({ traces, explanations, config }) {
  const codes = [];
  for (let i = 0; i < traces.length; i++) {
    const res = await openCode(traces[i], explanations[i]);
    codes.push(res);
  }

  const axial = await axialTrace(traces, codes.map((c) => c.code));
  const severity = (config && config.severity) || {};
  const defaultSev = severity.default ?? 3;

  const clusters = (axial.categories || []).map((cat) => {
    const members = cat.memberTraceIds || [];
    const hints = members.map((id) => {
      const idx = traces.findIndex((t) => t.id === id);
      return idx >= 0 && codes[idx] ? codes[idx].severityHint : defaultSev;
    }).filter((n) => typeof n === 'number');
    const avgHint = hints.length ? hints.reduce((a, b) => a + b, 0) / hints.length : defaultSev;
    // severity used for priority = USER-CONFIGURED severity, fall back to
    // model severity hint when the user has not named this category.
    const sev = severity[cat.name] ?? Math.max(1, Math.min(5, Math.round(avgHint)));
    const priority = +(members.length * sev).toFixed(2);
    return {
      name: cat.name,
      description: cat.description,
      count: members.length,
      traceIds: members,
      exampleCodes: (cat.exampleCodes || []).slice(0, 5),
      suggestedFixKind: cat.suggestedFixKind,
      severity,
      severityUsed: sev,
      priority,
    };
  });

  clusters.sort((a, b) => b.priority - a.priority);
  return { clusters, top: clusters[0] || null };
}

/** Offline version used by --mock: deterministic clustering by keyword. */
function mockClusterFailures(traces) {
  const buckets = new Map();
  for (const t of traces) {
    for (const e of t.evaluatorExplanations) {
      let key;
      if (/citat|source|hallucinat|contradict|unsupported|wrong value/i.test(e.explanation)) key = 'Unsupported factual claims';
      else if (/missing|required element|incomplete|dropped/i.test(e.explanation)) key = 'Missing required content';
      else key = 'Other';
      if (!buckets.has(key)) buckets.set(key, { name: key, description: '', traceIds: [], exampleCodes: [], suggestedFixKind: 'prompt' });
      buckets.get(key).traceIds.push(t.id);
      buckets.get(key).exampleCodes.push(e.explanation.slice(0, 60));
    }
  }
  const clusters = [...buckets.values()].map((c) => ({
    ...c,
    count: c.traceIds.length,
    exampleCodes: c.exampleCodes.slice(0, 5),
    severity: {},
    severityUsed: 3,
    priority: c.traceIds.length * 3,
  }));
  clusters.sort((a, b) => b.priority - a.priority);
  clusters[0].description = 'Agent asserts specifics (numbers, pages, values) that are absent from or contradict the retrieved source material.';
  if (clusters[1]) clusters[1].description = 'Agent omits elements the evaluator or policy requires (sections, mentions, references).';
  return { clusters, top: clusters[0] || null };
}

module.exports = { clusterFailures, mockClusterFailures, OPEN_CODE_SCHEMA, AXIAL_SCHEMA };
