'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { splitDataset, evaluatorsFrom, agentFrom, buildPatchedCopy } = require('../src/runner');
const { applyUnifiedDiff } = require('../src/util');

const path = require('path');
const ROOT = path.join(__dirname, '..');

test('splitDataset: deterministic, disjoint, union = whole', () => {
  const traces = Array.from({ length: 40 }, (_, i) => ({ id: 't' + i, agentInput: 'input ' + i, agentOutput: '', steps: [], evaluatorScores: {}, evaluatorExplanations: [], metadata: {} }));
  const a = splitDataset(traces, 's1', 0.75);
  const b = splitDataset(traces, 's1', 0.75);
  assert.deepStrictEqual(a, b);
  assert.strictEqual(a.dev.length + a.heldOut.length, traces.length);
  const ids = new Set([...a.dev.map((t) => t.id), ...a.heldOut.map((t) => t.id)]);
  assert.strictEqual(ids.size, traces.length);
  assert.strictEqual(a.dev.length, 30); // 75% of 40
});

test('evaluators and agent load from the dogfood example', () => {
  const config = require('../src/config').DEFAULT_CONFIG;
  const evs = evaluatorsFrom(ROOT, config);
  assert.ok(evs.length >= 2);
  assert.ok(evs.every((e) => typeof e.evaluate === 'function'));
  const agent = agentFrom(ROOT, config);
  assert.strictEqual(typeof agent.run, 'function');
});

test('buildPatchedCopy applies the mock proposal diff in a temp dir', async () => {
  const { mockProposeFix } = require('../src/proposer');
  const config = { ...(require('../src/config').DEFAULT_CONFIG), agent: { module: 'agent/agent.js' } };
  const top = { name: 'Unsupported factual claims', description: 'x', count: 3, exampleCodes: [], suggestedFixKind: 'prompt' };
  const proposal = mockProposeFix({ root: ROOT, config, topCluster: top });
  assert.ok(proposal.diff.includes('@@'));
  const tmp = buildPatchedCopy(ROOT, proposal);
  try {
    const patched = require('fs').readFileSync(path.join(tmp, 'agent', 'prompt.txt'), 'utf8');
    assert.ok(patched.includes('verbatim'));
    // original untouched
    const orig = require('fs').readFileSync(path.join(ROOT, 'agent', 'prompt.txt'), 'utf8');
    assert.ok(!orig.includes('verbatim'));
  } finally {
    require('fs').rmSync(tmp, { recursive: true, force: true });
  }
});

test('applyUnifiedDiff round-trips the proposer mock diff', () => {
  const fs = require('fs');
  const { mockProposeFix } = require('../src/proposer');
  const config = require('../src/config').DEFAULT_CONFIG;
  const proposal = mockProposeFix({ root: ROOT, config, topCluster: { name: 'x', count: 1, exampleCodes: [], suggestedFixKind: 'prompt' } });
  const original = fs.readFileSync(path.join(ROOT, 'agent', 'prompt.txt'), 'utf8');
  const { text } = applyUnifiedDiff(original, proposal.diff);
  assert.ok(text.includes('verbatim'));
  assert.ok(!text.includes('\n\n\n')); // no mangling
});
