'use strict';
/**
 * evalloop CLI
 *
 * Commands:
 *   evalloop init     [root]          Write a starter evalloop.config.json
 *   evalloop status   [root]          Show current run pointer + recent ledger
 *   evalloop pull     [root]          Fetch failed traces via the configured adapter
 *   evalloop cluster  [root]          Open+axial coding over failed traces -> clusters.json
 *   evalloop propose  [root]          Scan repo and produce a unified-diff proposal
 *   evalloop experiment [root]        Rerun failure + regression datasets, before/after report
 *   evalloop loop     [root] [--mock] Pull -> cluster -> propose -> experiment -> report
 */
const fs = require('fs');
const path = require('path');
const { loadConfig, resolveRoot, getCurrentRunId, runsDir } = require('./config');
const { getAdapter, redactTrace } = require('./adapters');
const { clusterFailures, mockClusterFailures } = require('./cluster');
const { proposeFix, mockProposeFix } = require('./proposer');
const { runExperiment } = require('./runner');
const store = require('./store');
const { readJsonl } = require('./util');

function args(argv) {
  const flags = { mock: false };
  const positional = [];
  for (const a of argv) {
    if (a === '--mock') flags.mock = true;
    else if (a === '--json') flags.json = true;
    else if (a === '--apply') flags.apply = true;
    else positional.push(a);
  }
  return { flags, positional };
}

function loadMockDataset(root) {
  // Mock mode: point the file adapter at the bundled dogfood traces.
  const { MockAdapter } = require('./adapters');
  return new MockAdapter();
}

async function cmdInit(root) {
  const { config, configPath, created } = loadConfig(root);
  if (created) console.log(`Wrote ${configPath} (defaults). Edit source.adapter, env names, severity, split.devRatio.`);
  else console.log(`Config already exists: ${configPath}`);
  // Ensure evals dir + REQUIREMENTS template exist for new users.
  const evalsDir = path.join(resolveRoot(root), 'evals');
  if (!fs.existsSync(evalsDir)) {
    fs.mkdirSync(evalsDir, { recursive: true });
    fs.writeFileSync(path.join(evalsDir, 'evaluators.js'), EVALUATORS_TEMPLATE);
    console.log('Wrote evals/evaluators.js template.');
  }
  const reqPath = path.join(resolveRoot(root), 'REQUIREMENTS.md');
  if (!fs.existsSync(reqPath)) {
    fs.writeFileSync(reqPath, REQUIREMENTS_TEMPLATE);
    console.log('Wrote REQUIREMENTS.md template.');
  }
  return config;
}

const EVALUATORS_TEMPLATE = `'use strict';
/**
 * Evaluators used by the experiment runner. Each returns { score: 0..1, explanation }.
 * Evaluators see the agent's INPUT, OUTPUT and the SOURCE it was given —
 * never eval answers. Add your own here.
 */
module.exports = {
  evaluators: [
    {
      name: 'grounding',
      evaluate: async ({ output, source }) => {
        if (!output) return { score: 0, explanation: 'Agent returned no output.' };
        // Replace with your real evaluator (LLM judge, regex, schema check...).
        const cites = (output.match(/\\[source \\d+\\]/g) || []).length;
        return { score: cites > 0 ? 1 : 0.4, explanation: cites > 0 ? 'Contains source citations.' : 'No source citations found.' };
      },
    },
  ],
};
`;

const REQUIREMENTS_TEMPLATE = `# REQUIREMENTS
# Real goals the agent must serve. The fix proposer reads this file so that
# patches optimize actual product goals — not only passing evals.

- The research agent must ground every factual claim in the provided sources.
- It must say "I don't know" when sources don't contain the answer.
- It must never fabricate page numbers, dates, or statistics.
`;

async function requireDataset(root, config, mock) {
  const adapter = mock ? getAdapter({ source: { adapter: 'mock' } }) : getAdapter(config);
  const traces = await adapter.fetchFailedTraces({ limit: config.limits.maxTraces });
  if (!traces.length) throw new Error('No failed traces found. Check source.adapter / endpoint / tracesFile.');
  const explanations = [];
  for (const t of traces) explanations.push(await adapter.fetchExplanations(t));
  return { adapter, traces, explanations };
}

async function cmdPull(root, { mock }) {
  const { config } = loadConfig(root);
  const runId = store.startRun(root, 'pull');
  const { adapter, traces } = await requireDataset(root, config, mock);
  store.saveRunArtifact(root, runId, 'traces.json', { traces: traces.map(redactTrace) });
  console.log(`Pulled ${traces.length} failed traces -> .evalloop/${runId}/traces.json (adapter: ${mock ? 'mock' : config.source.adapter})`);
  return { runId, traces };
}

async function cmdCluster(root, { mock }) {
  const { config } = loadConfig(root);
  const runId = getCurrentRunId(root) || store.startRun(root, 'cluster');
  const { traces, explanations } = await requireDataset(root, config, mock);

  let clusters;
  if (mock) {
    ({ clusters } = mockClusterFailures(traces));
  } else {
    ({ clusters } = await clusterFailures({ traces, explanations, config }));
  }

  store.saveRunArtifact(root, runId, 'clusters.json', { generatedAt: new Date().toISOString(), clusters });
  console.log(`Clustered ${traces.length} traces into ${clusters.length} root-cause categories:`);
  for (const c of clusters) {
    console.log(`  [priority ${c.priority}] ${c.name} — ${c.count} trace(s), severity ${c.severityUsed}, fix: ${c.suggestedFixKind}`);
  }
  return { runId, clusters };
}

async function cmdPropose(root, { mock }) {
  const { config } = loadConfig(root);
  const runId = getCurrentRunId(root) || store.startRun(root, 'propose');
  const clustersFile = store.loadRunArtifact(root, runId, 'clusters.json');
  if (!clustersFile) throw new Error('No clusters.json in the current run. Run `evalloop cluster` first.');
  const top = clustersFile.clusters[0];
  if (!top) throw new Error('No clusters found — nothing to fix.');

  const proposal = mock ? mockProposeFix({ root, config, topCluster: top }) : await proposeFix({ root, config, topCluster: top });
  store.saveRunArtifact(root, runId, 'proposal.json', proposal);
  // Raw diff for `git apply` convenience.
  fs.mkdirSync(store.runDir(root, runId), { recursive: true });
  fs.writeFileSync(path.join(store.runDir(root, runId), 'proposal.diff'), proposal.diff || '');
  console.log(`Proposal saved (.evalloop/${runId}/proposal.json). Files touched: ${(proposal.changedFiles || []).join(', ') || 'none'}`);
  console.log('--- DIFF ---');
  console.log(proposal.diff);
  return { runId, proposal };
}

async function cmdExperiment(root, { mock }) {
  const { config } = loadConfig(root);
  const runId = getCurrentRunId(root) || store.startRun(root, 'experiment');
  const proposal = store.loadRunArtifact(root, runId, 'proposal.json');
  if (!proposal) throw new Error('No proposal.json in the current run. Run `evalloop propose` first.');

  // Failure dataset: from the run's saved traces (proposer only ever saw cluster summaries).
  const savedTraces = store.loadRunArtifact(root, runId, 'traces.json');
  let failureTraces;
  if (savedTraces) failureTraces = savedTraces.traces;
  else failureTraces = (await requireDataset(root, config, mock)).traces;

  // Regression dataset of past passes.
  const regPath = path.resolve(root, 'traces/regression.jsonl');
  let regressionTraces = [];
  if (fs.existsSync(regPath)) {
    regressionTraces = readJsonl(regPath);
  } else if (!mock) {
    console.warn(`No regression dataset at ${regPath} — overfitting guard is OFF. Add past-pass traces there.`);
  } else {
    // mock: synthesize past-pass regression items
    regressionTraces = buildMockRegression();
  }

  const { report } = await runExperiment({ root, config, proposal, failureTraces, regressionTraces });
  store.saveRunArtifact(root, runId, 'report.json', report);

  const s = report.summary;
  console.log('\n=== BEFORE / AFTER ===');
  console.log(`dev failures  (n=${s.dev.n}):        ${s.dev.before.toFixed(3)} -> ${s.dev.after.toFixed(3)}  (Δ ${s.dev.delta >= 0 ? '+' : ''}${s.dev.delta})`);
  console.log(`held-out      (n=${s.heldOut.n}):        ${s.heldOut.before.toFixed(3)} -> ${s.heldOut.after.toFixed(3)}  (Δ ${s.heldOut.delta >= 0 ? '+' : ''}${s.heldOut.delta})`);
  console.log(`regression    (n=${s.regression.n}):        ${s.regression.before.toFixed(3)} -> ${s.regression.after.toFixed(3)}  (Δ ${s.regression.delta >= 0 ? '+' : ''}${s.regression.delta})`);
  console.log(`patch applied: ${s.patchApplied}`);
  console.log(`RECOMMENDATION: ${s.recommendation}`);
  console.log(`\nFull report: .evalloop/${runId}/report.json`);
  return { runId, report };
}

function buildMockRegression() {
  // 4 past-pass items: agent answered well before any patch. The regression
  // check verifies the patch doesn't break these.
  const mk = (input, source, goodAnswer) => ({
    id: 'reg-' + input.length + '-' + input.slice(0, 8).replace(/\W/g, ''),
    agentInput: input,
    source,
    evaluatorScores: { grounding: 1 },
    evaluatorExplanations: [],
    metadata: {},
  });
  return [
    mk('Summarize the pricing page', 'Pricing: Starter $10/mo, Pro $25/mo. Annual discount 20%.', 'x'),
    mk('What is the SLA for enterprise?', 'Enterprise SLA: 99.9% uptime, 4h response.', 'x'),
    mk('List supported regions', 'Regions: US-East, EU-West, AP-South.', 'x'),
    mk('Who is the data processor?', 'Processor: Acme Cloud Services LLC, per DPA section 2.', 'x'),
  ];
}

async function cmdLoop(root, { mock }) {
  console.log(`== evalloop loop${mock ? ' (mock)' : ''} ==`);
  await cmdInit(root);
  await cmdPull(root, { mock });
  await cmdCluster(root, { mock });
  await cmdPropose(root, { mock });
  await cmdExperiment(root, { mock });
  console.log('\nDone. Review the proposal and report, then decide whether to apply.');
  console.log('To apply a proposal manually: git apply < .evalloop/<runId>/proposal.diff');
}

async function cmdStatus(root) {
  const { config, configPath } = loadConfig(root);
  const runId = getCurrentRunId(root);
  console.log(`root:   ${resolveRoot(root)}`);
  console.log(`config: ${configPath} (adapter: ${config.source.adapter})`);
  console.log(`current run: ${runId || '(none)'}`);
  const events = store.listRuns(root);
  for (const e of events.slice(-20)) console.log(`  ${e.ts} ${e.runId} ${e.event}${e.name ? ' ' + e.name : ''}`);
}

async function run(argv) {
  const { flags, positional } = args(argv);
  const [cmd, rootArg] = positional;
  const root = rootArg || process.cwd();
  try {
    switch (cmd) {
      case 'init': return await cmdInit(root);
      case 'status': return await cmdStatus(root);
      case 'pull': return await cmdPull(root, flags);
      case 'cluster': return await cmdCluster(root, flags);
      case 'propose': return await cmdPropose(root, flags);
      case 'experiment': return await cmdExperiment(root, flags);
      case 'loop': return await cmdLoop(root, flags);
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        printHelp();
        return;
      default:
        console.error(`Unknown command: ${cmd}`);
        printHelp();
        process.exitCode = 1;
    }
  } catch (err) {
    console.error(`error: ${err.message}`);
    if (process.env.EVALLOOP_DEBUG) console.error(err.stack);
    process.exitCode = 1;
  }
}

function printHelp() {
  console.log(`evalloop — close the loop from failed traces to verified prompt fixes

Usage:
  evalloop <command> [root] [flags]

Commands:
  init        Write starter evalloop.config.json, evaluators template, REQUIREMENTS.md
  status      Show config, current run, recent ledger events
  pull        Fetch failed traces via the configured adapter (phoenix|langfuse|file|mock)
  cluster     Open+axial coding over evaluator explanations -> clusters.json
  propose     Scan the repo and emit a unified-diff fix proposal for the top cluster
  experiment  Rerun failure (75/25 dev/held-out) + regression datasets, before/after report
  loop        Run pull -> cluster -> propose -> experiment in one command

Flags:
  --mock      Fully offline demo: canned traces, deterministic cluster + patch
  --json      (future) JSON output
  --apply     Reserved for opt-in apply step (proposals are never auto-merged)

Docs: see README.md and SKILL.md in this repo.
`);
}

module.exports = { run };
