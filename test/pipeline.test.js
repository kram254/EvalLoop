'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');

test('scanner never returns excluded paths', () => {
  const { scanRepo } = require('../src/scanner');
  const config = require('../src/config').DEFAULT_CONFIG;
  const scan = scanRepo(ROOT, config);
  const all = [...scan.prompts, ...scan.retrieval, ...scan.tools];
  for (const f of all) {
    assert.ok(!f.relPath.includes('traces/'), `scanner leaked excluded path: ${f.relPath}`);
    assert.ok(!f.relPath.includes('.evalloop'), `scanner leaked .evalloop: ${f.relPath}`);
    assert.ok(!f.relPath.includes('test/'), `scanner leaked test dir: ${f.relPath}`);
  }
  assert.ok(all.some((f) => f.relPath === 'agent/prompt.txt'), 'scanner should find the dogfood prompt');
});

test('cluster: mock clustering groups by root cause and ranks by priority', () => {
  const { MockAdapter } = require('../src/adapters');
  const { mockClusterFailures } = require('../src/cluster');
  const adapter = new MockAdapter();
  return adapter.fetchFailedTraces({ limit: 50 }).then((traces) => {
    const { clusters, top } = mockClusterFailures(traces);
    assert.ok(clusters.length >= 2);
    assert.strictEqual(top, clusters[0]);
    const totalMembers = clusters.reduce((a, c) => a + c.count, 0);
    assert.ok(totalMembers >= traces.length, 'every trace explanation should be clustered');
    assert.ok(top.priority >= clusters[clusters.length - 1].priority);
    assert.ok(/Unsupported factual/.test(top.name));
  });
});

test('runner: full controlled experiment on the dogfood agent (offline, no LLM)', async () => {
  // Point config at the dogfood example; use file adapter traces.
  const { runExperiment } = require('../src/runner');
  const { mockProposeFix } = require('../src/proposer');
  const { FileAdapter } = require('../src/adapters');
  const { DEFAULT_CONFIG } = require('../src/config');
  const { readJsonl } = require('../src/util');

  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.agent = { module: 'agent/agent.js' };
  config.evaluators = { module: 'evals/evaluators.js' };

  const adapter = new FileAdapter({ tracesFile: path.join(ROOT, 'traces', 'failures.jsonl') });
  const failureTraces = await adapter.fetchFailedTraces({ limit: 50 });
  const regressionTraces = readJsonl(path.join(ROOT, 'traces', 'regression.jsonl'));

  const top = { name: 'Unsupported factual claims', description: 'asserts specifics absent from source', count: 3, exampleCodes: [], suggestedFixKind: 'prompt' };
  const proposal = mockProposeFix({ root: ROOT, config, topCluster: top });

  const { report, patchApplied } = await runExperiment({ root: ROOT, config, proposal, failureTraces, regressionTraces });

  assert.strictEqual(patchApplied, true, 'the mock diff must apply cleanly');
  const s = report.summary;
  // Held-out must be reported separately:
  assert.ok(typeof s.heldOut.before === 'number');
  assert.ok(typeof s.dev.before === 'number');
  // The tightened prompt makes the agent decline unsourced answers, which the
  // grounding evaluator scores higher on failure items:
  assert.ok(s.dev.delta > 0, `dev should improve, got ${JSON.stringify(s.dev)}`);
  assert.ok(s.regression.delta >= -0.02, `regression set should not collapse, got ${JSON.stringify(s.regression)}`);
  assert.match(s.recommendation, /PROPOSE|REJECT|REVIEW/);
});

test('proposer: mock proposal contains anti-cheat checklist', () => {
  const { mockProposeFix } = require('../src/proposer');
  const { DEFAULT_CONFIG } = require('../src/config');
  const p = mockProposeFix({ root: ROOT, config: DEFAULT_CONFIG, topCluster: { name: 'x', count: 1, exampleCodes: [], suggestedFixKind: 'prompt' } });
  assert.strictEqual(p.antiCheatChecklist.noTestDataInPrompt, true);
  assert.strictEqual(p.antiCheatChecklist.addressesPatternNotInstances, true);
  assert.ok(p.diff.length > 50);
});

test('ledger records events across a run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'el-run-'));
  const store = require('../src/store');
  const runId = store.startRun(dir, 'pull');
  store.logRun(dir, runId, 'artifact', { name: 'traces.json' });
  store.saveRunArtifact(dir, runId, 'clusters.json', { clusters: [] });
  const events = store.listRuns(dir);
  assert.ok(events.length >= 3);
  assert.ok(events.some((e) => e.event === 'start'));
  const loaded = store.loadRunArtifact(dir, runId, 'clusters.json');
  assert.deepStrictEqual(loaded, { clusters: [] });
});
