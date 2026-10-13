'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { PhoenixAdapter, LangfuseAdapter, FileAdapter, MockAdapter, assertTrace, redact, getAdapter, AdapterError } = require('../src/adapters');

test('assertTrace fills defaults and requires id/agentInput', () => {
  assert.throws(() => assertTrace({ agentInput: 'x' }, 't'), /missing required field 'id'/);
  const t = assertTrace({ id: 5, agentInput: 'hello' }, 't');
  assert.strictEqual(t.id, '5');
  assert.strictEqual(t.agentOutput, null);
  assert.deepStrictEqual(t.evaluatorScores, {});
});

test('redact removes api keys and truncates', () => {
  const s = redact('key sk-ant-abcdefghijklmnop123456 and Bearer eyJhbGciOi.xyz', 100);
  assert.ok(!s.includes('sk-ant-'));
  assert.ok(s.includes('[REDACTED]'));
  const t = redact('x'.repeat(500), 50);
  assert.ok(t.includes('[truncated 450 chars]'));
});

test('MockAdapter serves failing traces and explanations', async () => {
  const a = new MockAdapter();
  const traces = await a.fetchFailedTraces({ limit: 100 });
  assert.ok(traces.length >= 5);
  for (const t of traces) {
    const exp = await a.fetchExplanations(t);
    assert.ok(exp.length > 0);
  }
  const ack = await a.pushExperimentResult({ runId: 'r1', report: { summary: {} } });
  assert.ok(ack.ack);
});

test('FileAdapter filters failures from jsonl', async () => {
  const path = require('path');
  const a = new FileAdapter({ tracesFile: path.join(__dirname, '..', 'traces', 'failures.jsonl') });
  const traces = await a.fetchFailedTraces({ limit: 10 });
  assert.strictEqual(traces.length, 6);
});

test('Phoenix adapter requires endpoint', () => {
  assert.throws(() => new PhoenixAdapter({}), AdapterError);
});

test('Langfuse adapter requires keys at call time', async () => {
  const a = new LangfuseAdapter({ endpoint: 'https://lf.example' });
  await assert.rejects(() => a.fetchFailedTraces(), /LANGFUSE_PUBLIC_KEY/);
});

test('getAdapter switches on config.source.adapter', () => {
  assert.ok(getAdapter({ source: { adapter: 'mock' } }) instanceof MockAdapter);
  assert.throws(() => getAdapter({ source: { adapter: 'bogus' } }), /Unknown adapter/);
});
