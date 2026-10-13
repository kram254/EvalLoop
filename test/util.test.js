'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { stableShuffle, applyUnifiedDiff, sha256, readJsonl, writeJson, readJson } = require('../src/util');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('stableShuffle is deterministic for same seed', () => {
  const items = [1, 2, 3, 4, 5, 6, 7, 8];
  const a = stableShuffle(items, 'seed-1');
  const b = stableShuffle(items, 'seed-1');
  assert.deepStrictEqual(a, b);
  assert.notDeepStrictEqual(a, items); // actually shuffled
});

test('stableShuffle preserves elements', () => {
  const items = ['a', 'b', 'c', 'd', 'e'];
  const shuffled = stableShuffle(items, 'x');
  assert.deepStrictEqual(shuffled.slice().sort(), items.slice().sort());
});

test('applyUnifiedDiff applies a simple change', () => {
  const original = ['line1', 'line2', 'line3', 'line4', 'line5'].join('\n');
  const diff = ['--- a/f', '+++ b/f', '@@ -2,3 +2,3 @@', ' line2', '-line3', '+LINE3', ' line4'].join('\n');
  const { text, changed } = applyUnifiedDiff(original, diff);
  assert.ok(changed);
  assert.ok(text.includes('LINE3'));
  assert.ok(text.includes('line2'));
});

test('applyUnifiedDiff throws on stale context', () => {
  const original = 'a\nb\nc';
  const diff = '@@ -1,3 +1,3 @@\n a\n-zzz\n+c';
  assert.throws(() => applyUnifiedDiff(original, diff), /context mismatch|expected/i);
});

test('sha256 hex output', () => {
  assert.strictEqual(sha256('abc').length, 64);
});

test('jsonl roundtrip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'el-'));
  const f = path.join(dir, 'x.jsonl');
  writeJson(f + '.meta.json', { a: 1 });
  const { appendJsonl } = require('../src/util');
  appendJsonl(f, { n: 1 });
  appendJsonl(f, { n: 2 });
  assert.deepStrictEqual(readJsonl(f).map((r) => r.n), [1, 2]);
});
