'use strict';
/**
 * Shared utilities: HTTP JSON requests via global fetch (no dependencies),
 * JSONL append, hashing, filesystem helpers, and a tiny diff applier.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

async function postJson(url, body, { apiKey, apiHeaderName = 'x-api-key', anthropicVersion, extraHeaders = {}, timeoutMs = 120000 } = {}) {
  const headers = { 'content-type': 'application/json', ...extraHeaders };
  if (apiKey) {
    headers[apiHeaderName] = apiKey;
    if (anthropicVersion) headers['anthropic-version'] = anthropicVersion;
  }
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!res.ok) {
      const detail = data && data.error && data.error.message ? data.error.message : text.slice(0, 300);
      const err = new Error(`HTTP ${res.status} from ${url}: ${detail}`);
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(t);
  }
}

function appendJsonl(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(record) + '\n');
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('>')) // allow comment headers in fixture files
    .map((l) => {
      try { return JSON.parse(l); } catch (e) { return { _unparsable: l, _error: String(e) }; }
    });
}

function readJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function sha256(str) {
  return crypto.createHash('sha256').update(String(str)).digest('hex');
}

/** Deterministic shuffle so dev/held-out splits are stable across runs. */
function stableShuffle(items, seedStr) {
  const arr = items.slice();
  let seed = parseInt(crypto.createHash('sha256').update(seedStr).digest('hex').slice(0, 12), 16);
  const rand = () => {
    // xorshift
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >> 17;
    seed ^= seed << 5; seed >>>= 0;
    return seed / 0xffffffff;
  };
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Apply a minimal unified diff to a string. Returns { text, changed }.
 * Supports @@ -a,b +c,d @@ headers with ' ', '-', '+' context lines only.
 * Throws if any hunk's context does not match (patch is stale).
 */
function applyUnifiedDiff(original, diffText) {
  const lines = diffText.split('\n');
  const hunks = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith('@@')) {
      current = { header: line, lines: [] };
      hunks.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  let src = original.split('\n');
  // Apply hunks bottom-up so earlier offsets stay valid.
  for (const hunk of hunks.reverse()) {
    const m = hunk.header.match(/^@@\s*-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s*@/);
    if (!m) throw new Error(`Bad hunk header: ${hunk.header}`);
    const startOld = parseInt(m[1], 10);
    const body = hunk.lines.filter((l) => l !== '' || true); // keep as-is
    // Trim trailing empty artifacts
    while (body.length && body[body.length - 1] === '\\ No newline at end of file') body.pop();
    const oldLines = [];
    for (const l of body) {
      if (l.startsWith('+') || l === '') continue; // additions & pure-empty trailing lines skipped from old
      if (l.startsWith('-')) oldLines.push(l.slice(1));
      else oldLines.push(l.startsWith(' ') ? l.slice(1) : l);
    }
    const newLines = [];
    for (const l of body) {
      if (l.startsWith('-')) continue;
      newLines.push(l.startsWith('+') || l.startsWith(' ') ? l.slice(1) : l);
    }
    // Find the old block starting at startOld-1 (exact match required)
    const idx = startOld - 1;
    for (let i = 0; i < oldLines.length; i++) {
      if (src[idx + i] !== oldLines[i]) {
        throw new Error(`Patch context mismatch at line ${idx + i + 1}: expected ${JSON.stringify(oldLines[i])}, found ${JSON.stringify(src[idx + i])}. Diff may be stale.`);
      }
    }
    src.splice(idx, oldLines.length, ...newLines);
  }
  return { text: src.join('\n'), changed: hunks.length > 0 };
}

module.exports = { postJson, appendJsonl, readJsonl, readJson, writeJson, sha256, stableShuffle, applyUnifiedDiff };
