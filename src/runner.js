'use strict';
/**
 * Experiment runner.
 *
 * Protocol:
 *   - The failure dataset (traces pulled from the adapter) is split 75/25 into
 *     DEV and HELD-OUT using a deterministic seed. The proposer only ever saw
 *     DEV-derived cluster summaries; held-out traces are touched first HERE.
 *   - A REGRESSION dataset of past PASSES (from a JSONL file of previously
 *     passing traces) guards against overfitting to failures.
 *   - Both datasets are rerun against the CURRENT agent (dev), then the
 *     proposed patch is applied to a TEMP CHECKOUT, and the same runs execute
 *     against the patched agent. Same evaluators, same inputs.
 *   - Report shows dev and held-out deltas SEPARATELY.
 *
 * Evaluator contract: a JS module (default evals/evaluators.js) exporting
 *   { evaluate({ input, output, source }) -> { score: 0..1, explanation } }
 * or an array of such evaluators. They receive the agent's output and the
 * same SOURCE the agent saw — never eval answers.
 *
 * Agent contract: a JS module (default agent/agent.js) exporting
 *   async run({ input, source }) -> string   (the agent under test)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { stableShuffle, applyUnifiedDiff } = require('./util');
const { redact } = require('./adapters');

function loadModule(root, rel, what) {
  const abs = path.resolve(root, rel);
  if (!fs.existsSync(abs)) throw new Error(`${what} module not found: ${rel}`);
  delete require.cache[abs];
  const mod = require(abs);
  return mod;
}

function evaluatorsFrom(root, config) {
  const rel = (config.evaluators && config.evaluators.module) || 'evals/evaluators.js';
  const mod = loadModule(root, rel, 'Evaluators');
  const list = Array.isArray(mod) ? mod : mod.evaluators || [mod];
  return list.filter((e) => typeof e.evaluate === 'function').map((e, i) => ({
    name: e.name || `evaluator-${i}`,
    evaluate: e.evaluate,
  }));
}

function agentFrom(root, config) {
  const rel = (config.agent && config.agent.module) || 'agent/agent.js';
  return loadModule(root, rel, 'Agent');
}

/**
 * Split traces into dev / held-out. Uses the trace input text as the
 * identity basis; the seed is the run id so re-running the SAME run reproduces
 * the split, while each new experiment re-randomizes.
 */
function splitDataset(traces, seed, devRatio = 0.75) {
  const shuffled = stableShuffle(traces, seed);
  const devCount = Math.max(1, Math.floor(shuffled.length * devRatio));
  return { dev: shuffled.slice(0, devCount), heldOut: shuffled.slice(devCount) };
}

async function evalOne(agentFn, evaluators, item) {
  let output = null;
  let agentError = null;
  try {
    output = await agentFn.run({ input: item.agentInput, source: item.source });
  } catch (e) {
    agentError = String(e.message || e);
  }
  const results = [];
  for (const ev of evaluators) {
    try {
      const r = await ev.evaluate({ input: item.agentInput, output, source: item.source, agentError });
      results.push({ evaluator: ev.name, score: Number(r.score), explanation: String(r.explanation || '') });
    } catch (e) {
      results.push({ evaluator: ev.name, score: 0, explanation: `evaluator error: ${e.message}` });
    }
  }
  const mean = results.length ? results.reduce((a, b) => a + b.score, 0) / results.length : 0;
  return { input: item.agentInput, output, agentError, results, meanScore: +mean.toFixed(4) };
}

async function evalSet(agentFn, evaluators, items, label) {
  const out = [];
  for (const item of items) out.push(await evalOne(agentFn, evaluators, item));
  const mean = out.length ? out.reduce((a, b) => a + b.meanScore, 0) / out.length : 0;
  return { label, items: out, meanScore: +mean.toFixed(4), n: out.length };
}

/** Apply the proposed diff to a pristine temp copy of the repo root. */
function buildPatchedCopy(root, proposal) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evalloop-patched-'));
  fs.cpSync(root, tmp, { recursive: true, filter: (src) => !src.includes(path.join(root, '.evalloop')) && !src.includes(`${path.sep}.evalloop`) });
  for (const rel of proposal.changedFiles || []) {
    if (!proposal.diff) continue;
    const abs = path.resolve(tmp, rel);
    if (!fs.existsSync(abs)) throw new Error(`Diff targets missing file: ${rel}`);
    const original = fs.readFileSync(abs, 'utf8');
    const { text } = applyUnifiedDiff(original, proposal.diff);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return tmp;
}

/**
 * Run the controlled experiment.
 * Returns the before/after report with dev and held-out sections.
 */
async function runExperiment({ root, config, proposal, failureTraces, regressionTraces }) {
  const devRatio = (config.split && config.split.devRatio) ?? 0.75;
  const seed = 'evalloop-split-v1'; // stable across runs of the same dataset

  const devSet = splitDataset(failureTraces, seed + ':dev', devRatio).dev;
  const heldOut = splitDataset(failureTraces, seed + ':heldout', devRatio).heldOut;
  const evaluators = evaluatorsFrom(root, config);

  const agentBaseline = agentFrom(root, config);

  // 1. Baseline: current agent on dev failures, held-out failures, regression set.
  const beforeDev = await evalSet(agentBaseline, evaluators, devSet, 'dev-failures');
  const beforeHeld = await evalSet(agentBaseline, evaluators, heldOut, 'heldout-failures');
  const beforeReg = await evalSet(agentBaseline, evaluators, regressionTraces, 'regression');

  // 2. Patched agent: apply diff in temp checkout, load patched agent module.
  let tmpCopy = null;
  let patchedAgent = agentBaseline;
  let patchApplied = false;
  if (proposal && proposal.diff && (proposal.changedFiles || []).length) {
    try {
      tmpCopy = buildPatchedCopy(root, proposal);
      // Load the patched agent from the temp copy.
      const rel = (config.agent && config.agent.module) || 'agent/agent.js';
      patchedAgent = loadModule(tmpCopy, rel, 'Patched agent');
      patchApplied = true;
    } catch (err) {
      // A bad/stale diff must not silently count as "improvement".
      patchApplied = false;
      proposal._applyError = String(err.message || err);
    }
  }

  const afterDev = patchApplied ? await evalSet(patchedAgent, evaluators, devSet, 'dev-failures') : beforeDev;
  const afterHeld = patchApplied ? await evalSet(patchedAgent, evaluators, heldOut, 'heldout-failures') : beforeHeld;
  const afterReg = patchApplied ? await evalSet(patchedAgent, evaluators, regressionTraces, 'regression') : beforeReg;

  if (tmpCopy) fs.rmSync(tmpCopy, { recursive: true, force: true });

  const deltas = {
    dev: +(afterDev.meanScore - beforeDev.meanScore).toFixed(4),
    heldOut: +(afterHeld.meanScore - beforeHeld.meanScore).toFixed(4),
    regression: +(afterReg.meanScore - beforeReg.meanScore).toFixed(4),
  };

  const report = {
    summary: {
      dev: { before: beforeDev.meanScore, after: afterDev.meanScore, delta: deltas.dev, n: beforeDev.n },
      heldOut: { before: beforeHeld.meanScore, after: afterHeld.meanScore, delta: deltas.heldOut, n: beforeHeld.n },
      regression: { before: beforeReg.meanScore, after: afterReg.meanScore, delta: deltas.regression, n: beforeReg.n },
      patchApplied,
      recommendation: recommendation(deltas, patchApplied),
    },
    detail: {
      dev: { before: beforeDev, after: afterDev },
      heldOut: { before: beforeHeld, after: afterHeld },
      regression: { before: beforeReg, after: afterReg },
    },
  };
  return { report, patchApplied, tmpCopy };
}

function recommendation(deltas, patchApplied) {
  if (!patchApplied) return 'REJECT: patch could not be applied (stale or invalid diff).';
  const { dev: dDev, heldOut: dHeld, regression: dReg } = deltas;
  if (dHeld <= 0) return 'REJECT: no improvement on the held-out failure set.';
  if (dDev > 0 && dHeld > 0 && dReg < -0.02) return 'REJECT: dev improved but regression set dropped — likely overfitting to failures.';
  if (dDev > 0 && dHeld > 0) return 'PROPOSE: improvement on both dev and held-out with no regression-set decline.';
  return 'REVIEW: mixed results — inspect per-item detail before deciding.';
}

module.exports = { runExperiment, splitDataset, evalSet, evalOne, buildPatchedCopy, evaluatorsFrom, agentFrom };
