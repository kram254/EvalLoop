'use strict';
/**
 * Config + run store.
 * - evalloop.config.json in the run root defines source adapter, credentials
 *   via env-var references, priority weights (severity per category is set by
 *   the USER here), dataset split sizes, and repo paths to scan.
 * - Runs live under .evalloop/ as an append-only JSONL ledger plus JSON
 *   snapshots, so every experiment is reproducible and auditable.
 */
const fs = require('fs');
const path = require('path');
const { readJson, writeJson } = require('./util');

const DEFAULT_CONFIG = {
  source: {
    adapter: 'phoenix',            // 'phoenix' | 'langfuse' | 'file'
    projectName: 'default',
    // Secrets are read from the environment, never stored in the config file.
    env: {
      endpoint: 'PHOENIX_ENDPOINT',        // e.g. https://phoenix.internal
      apiKey: 'PHOENIX_API_KEY',
    },
    // For adapter: 'file' — where to read failure traces from.
    tracesFile: 'traces/failures.jsonl',
  },
  repo: {
    root: '.',                    // where to scan for prompts / config
    promptGlobs: ['**/*.{md,txt,json,yaml,yml,js,ts,py}'],
    promptHints: ['prompt', 'system_prompt', 'instructions', 'TEMPLATE'],
    // NEVER scan or patch these (anti-cheat): eval data & held-out material.
    exclude: ['**/node_modules/**', '**/.evalloop/**', '**/evals/**', '**/traces/**', '**/datasets/**', '**/fixtures/**', '**/*.eval.jsonl'],
  },
  evaluators: {
    // Used by the experiment runner. Functions or HTTP evaluators resolved
    // from evals/evaluators.js (loaded separately — see runner).
    module: 'evals/evaluators.js',
  },
  split: { devRatio: 0.75 },      // 75% dev / 25% held-out, deterministic seed
  severity: {
    // USER-CONFIGURED severity per root-cause category (1-5). Unknown
    // categories get the default. priority = frequency x severity.
    default: 3,
  },
  limits: {
    maxTraces: 200,               // per pull
    maxPatchFiles: 3,             // cap on files touched per proposed patch
  },
};

function resolveRoot(root) {
  const abs = path.resolve(root);
  if (!fs.existsSync(abs)) fs.mkdirSync(abs, { recursive: true });
  return abs;
}

function loadConfig(root) {
  const abs = resolveRoot(root);
  const file = path.join(abs, 'evalloop.config.json');
  const user = readJson(file, null);
  if (!user) {
    writeJson(file, DEFAULT_CONFIG);
    return { config: DEFAULT_CONFIG, configPath: file, root: abs, created: true };
  }
  // shallow-merge user overrides over defaults (2 levels deep)
  const merged = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  for (const [k, v] of Object.entries(user)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && merged[k] && typeof merged[k] === 'object') {
      Object.assign(merged[k], v);
    } else {
      merged[k] = v;
    }
  }
  return { config: merged, configPath: file, root: abs, created: false };
}

const RUNS_DIR = '.evalloop';
const LEDGER = 'ledger.jsonl';

function runsDir(root) {
  return path.join(resolveRoot(root), RUNS_DIR);
}

function ledgerPath(root) {
  return path.join(runsDir(root), LEDGER);
}

function currentPointerPath(root) {
  return path.join(runsDir(root), 'current.json');
}

function setCurrentRun(root, runId) {
  writeJson(currentPointerPath(root), { runId });
}

function getCurrentRunId(root) {
  const p = readJson(currentPointerPath(root), null);
  return p ? p.runId : null;
}

module.exports = {
  DEFAULT_CONFIG,
  loadConfig,
  resolveRoot,
  runsDir,
  ledgerPath,
  setCurrentRun,
  getCurrentRunId,
};
