'use strict';
/**
 * Run store: every command writes to an append-only ledger under
 * .evalloop/ledger.jsonl plus JSON snapshots, so runs are reproducible.
 */
const path = require('path');
const fs = require('fs');
const { ledgerPath, runsDir, resolveRoot, setCurrentRun } = require('./config');
const { appendJsonl, readJsonl, writeJson, readJson } = require('./util');

function newRunId() {
  return 'run-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '-' + Math.random().toString(36).slice(2, 6);
}

function startRun(root, kind) {
  const runId = newRunId();
  appendJsonl(ledgerPath(root), { ts: new Date().toISOString(), runId, kind, event: 'start' });
  setCurrentRun(root, runId);
  return runId;
}

function logRun(root, runId, event, data = {}) {
  appendJsonl(ledgerPath(root), { ts: new Date().toISOString(), runId, event, ...data });
}

function runDir(root, runId) {
  return path.join(runsDir(root), runId);
}

function saveRunArtifact(root, runId, name, obj) {
  const file = path.join(runDir(root, runId), name);
  writeJson(file, obj);
  logRun(root, runId, 'artifact', { name });
  return file;
}

function loadRunArtifact(root, runId, name) {
  return readJson(path.join(runDir(root, runId), name), null);
}

function listRuns(root) {
  const file = ledgerPath(root);
  if (!fs.existsSync(file)) return [];
  return readJsonl(file);
}

module.exports = { newRunId, startRun, logRun, runDir, saveRunArtifact, loadRunArtifact, listRuns };
