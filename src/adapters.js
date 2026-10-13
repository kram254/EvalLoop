'use strict';
/**
 * Trace adapter interface. Every adapter implements:
 *   fetchFailedTraces({ projectName, limit }) -> [Trace]
 *   fetchExplanations(trace)                  -> string   (evaluator explanations)
 *   pushExperimentResult({ runId, report })   -> object   (ack)
 *
 * Trace shape (canonical):
 * {
 *   id: string,                 // stable trace id from the tracing vendor
 *   agentInput: string,         // user/task input given to the agent
 *   agentOutput: string|null,   // final output produced (may be null on hard failure)
 *   source: array|null,         // source documents the original run retrieved (for reruns)
 *   steps: [{ role, content }], // intermediate trace steps (redacted of system prompts by default)
 *   evaluatorScores: object,    // { evaluatorName: number } where available
 *   evaluatorExplanations: [{ evaluator, explanation }],
 *   metadata: object            // vendor-specific ids, timestamps
 * }
 */

class AdapterError extends Error {}

function assertTrace(t, origin) {
  for (const field of ['id', 'agentInput']) {
    if (t[field] === undefined) throw new AdapterError(`${origin}: trace missing required field '${field}'`);
  }
  return {
    id: String(t.id),
    agentInput: String(t.agentInput ?? ''),
    agentOutput: t.agentOutput == null ? null : String(t.agentOutput),
    source: Array.isArray(t.source) ? t.source : null,
    steps: Array.isArray(t.steps) ? t.steps : [],
    evaluatorScores: t.evaluatorScores && typeof t.evaluatorScores === 'object' ? t.evaluatorScores : {},
    evaluatorExplanations: Array.isArray(t.evaluatorExplanations) ? t.evaluatorExplanations : [],
    metadata: t.metadata || {},
  };
}

/** Redact obvious secrets and oversized payloads before anything leaves the process. */
function redact(text, maxLen = 4000) {
  let s = String(text ?? '');
  s = s.replace(/(sk-ant-|sk-)[A-Za-z0-9_-]{8,}/g, '[REDACTED_KEY]');
  s = s.replace(/Bearer\s+[A-Za-z0-9._-]{8,}/g, 'Bearer [REDACTED]');
  if (s.length > maxLen) s = s.slice(0, maxLen) + `…[truncated ${s.length - maxLen} chars]`;
  return s;
}

function redactTrace(t) {
  return {
    ...t,
    agentInput: redact(t.agentInput),
    agentOutput: t.agentOutput == null ? null : redact(t.agentOutput),
    steps: t.steps.map((s) => ({ role: s.role, content: redact(s.content) })),
  };
}

class PhoenixAdapter {
  constructor({ endpoint, apiKey, projectName }) {
    if (!endpoint) throw new AdapterError('Phoenix adapter requires endpoint (PHOENIX_ENDPOINT)');
    this.endpoint = endpoint.replace(/\/$/, '');
    this.apiKey = apiKey || '';
    this.projectName = projectName || 'default';
  }

  headers() {
    const h = { 'content-type': 'application/json' };
    if (this.apiKey) h['authorization'] = `Bearer ${this.apiKey}`;
    return h;
  }

  /**
   * Uses the GraphQL API (standard for Phoenix) to pull spans of root spans
   * whose evaluators flagged failure. Tolerates vendor schema drift by
   * reading from common field names.
   */
  async fetchFailedTraces({ limit = 200 } = {}) {
    const query = `
      query ($projectName: String!, $first: Int) {
        projects(first: 1, filter: {name: {equals: $projectName}}) {
          edges { node {
            datasets(first: 1) { edges { node { examples(first: $first) { edges { node { input output metadata } } } } } }
          } }
        }
      }`;
    // NOTE: deployments vary; fall back to the REST spans endpoint if GraphQL
    // is unavailable. We try GraphQL first, then /v1/projects.
    try {
      const data = await this._post('/graphql', { query, variables: { projectName: this.projectName, first: limit } });
      const examples = data?.data?.projects?.edges?.[0]?.node?.datasets?.edges?.[0]?.node?.examples?.edges || [];
      return examples.map((e) => this._fromExample(e.node)).filter((t) => this._isFailure(t));
    } catch (err) {
      if (err.status === 404) return this._restFallback({ limit });
      throw err;
    }
  }

  async _post(urlPath, body) {
    const { postJson } = require('./util');
    return postJson(this.endpoint + urlPath, body, { apiKey: this.apiKey, apiHeaderName: 'authorization', timeoutMs: 60000 });
  }

  async _restFallback({ limit }) {
    const res = await fetch(`${this.endpoint}/v1/projects/${encodeURIComponent(this.projectName)}/spans?limit=${limit}`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new AdapterError(`Phoenix REST fallback failed: HTTP ${res.status}`);
    const data = await res.json();
    return (data.data || []).map((s) => this._fromSpan(s)).filter((t) => this._isFailure(t));
  }

  _fromExample(node) {
    return assertTrace({
      id: node.metadata?.traceId || node.metadata?.spanId || `phx-${Math.random().toString(36).slice(2, 10)}`,
      agentInput: typeof node.input === 'string' ? node.input : JSON.stringify(node.input),
      agentOutput: node.output == null ? null : typeof node.output === 'string' ? node.output : JSON.stringify(node.output),
      steps: [],
      evaluatorScores: {},
      evaluatorExplanations: [],
      metadata: node.metadata || {},
    }, 'phoenix.example');
  }

  _fromSpan(node) {
    return assertTrace({
      id: node.context?.trace_id || node.span_id || `phx-${Math.random().toString(36).slice(2, 10)}`,
      agentInput: node.input_value || '',
      agentOutput: node.output_value || null,
      steps: [],
      evaluatorScores: {},
      evaluatorExplanations: node.annotations?.map((a) => ({ evaluator: a.name, explanation: a.result || '' })) || [],
      metadata: node,
    }, 'phoenix.span');
  }

  _isFailure(t) {
    if (t.evaluatorExplanations.length) return true;
    const scores = Object.values(t.evaluatorScores);
    return scores.length > 0 && scores.some((s) => typeof s === 'number' && s < 0.5);
  }

  async fetchExplanations(trace) {
    // Pull evaluator annotations for this trace.
    try {
      const data = await this._post('/graphql', {
        query: `query ($traceId: ID!) { node(id: $traceId) { ... on Span { annotations { name result } } } }`,
        variables: { traceId: trace.id },
      });
      const anns = data?.data?.node?.annotations || [];
      return anns.map((a) => `${a.name}: ${a.result}`).join('\n') || 'No evaluator explanations recorded.';
    } catch {
      return trace.evaluatorExplanations.map((e) => `${e.evaluator}: ${e.explanation}`).join('\n') || 'No evaluator explanations recorded.';
    }
  }

  async pushExperimentResult({ runId, report }) {
    // Phoenix: log as a project-level annotation-style record via REST if
    // available; otherwise no-op with ack (results remain in .evalloop).
    try {
      await fetch(`${this.endpoint}/v1/projects/${encodeURIComponent(this.projectName)}/experiments`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ name: `evalloop-${runId}`, metadata: { summary: report.summary } }),
      });
    } catch { /* non-fatal */ }
    return { ack: true, runId };
  }
}

class LangfuseAdapter {
  constructor({ endpoint, apiKey, publicKey }) {
    if (!endpoint) throw new AdapterError('Langfuse adapter requires endpoint (LANGFUSE_ENDPOINT)');
    this.endpoint = endpoint.replace(/\/$/, '');
    this.secretKey = apiKey || '';
    this.publicKey = publicKey || '';
  }

  authHeader() {
    if (!this.secretKey || !this.publicKey) throw new AdapterError('Langfuse needs LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY');
    return 'Basic ' + Buffer.from(`${this.publicKey}:${this.secretKey}`).toString('base64');
  }

  async fetchFailedTraces({ limit = 200 } = {}) {
    // Langfuse scores API: scores < 0.5 are treated as failures. Docs:
    // GET /api/public/traces?tags=...  — we filter client-side on scores.
    const url = `${this.endpoint}/api/public/traces?limit=${limit}`;
    const res = await fetch(url, { headers: { authorization: this.authHeader() } });
    if (!res.ok) throw new AdapterError(`Langfuse fetch failed: HTTP ${res.status}`);
    const data = await res.json();
    const traces = data.data || [];
    return traces
      .map((t) => this._fromLangfuse(t))
      .filter((t) => (t.evaluatorScores ? Object.values(t.evaluatorScores).some((s) => typeof s === 'number' && s < 0.5) : t.evaluatorExplanations.length > 0));
  }

  _fromLangfuse(t) {
    return assertTrace({
      id: t.id,
      agentInput: typeof t.input === 'string' ? t.input : JSON.stringify(t.input ?? {}),
      agentOutput: t.output == null ? null : typeof t.output === 'string' ? t.output : JSON.stringify(t.output),
      steps: (t.observations || []).map((o) => ({ role: o.type === 'GENERATION' ? 'assistant' : 'system', content: o.input ? JSON.stringify(o.input).slice(0, 2000) : '' })),
      evaluatorScores: Object.fromEntries((t.scores || []).map((s) => [s.name, s.value])),
      evaluatorExplanations: (t.scores || []).map((s) => ({ evaluator: s.name, explanation: s.comment || '' })),
      metadata: { timestamp: t.timestamp, environment: t.environment },
    }, 'langfuse');
  }

  async fetchExplanations(trace) {
    const res = await fetch(`${this.endpoint}/api/public/traces/${trace.id}`, { headers: { authorization: this.authHeader() } });
    if (!res.ok) return 'No evaluator explanations recorded.';
    const t = await res.json();
    return (t.scores || []).map((s) => `${s.name}: ${s.comment || s.value}`).join('\n') || 'No evaluator explanations recorded.';
  }

  async pushExperimentResult({ runId, report }) {
    const res = await fetch(`${this.endpoint}/api/public/datasets`, {
      method: 'POST',
      headers: { authorization: this.authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify({ name: `evalloop-run-${runId}`, metadata: { summary: report.summary } }),
    });
    return { ack: res.ok, runId, status: res.status };
  }
}

/**
 * FileAdapter: read traces from a local JSONL file — used for offline demos,
 * dogfooding, and the mock mode. Explanations come from the trace itself.
 */
class FileAdapter {
  constructor({ tracesFile }) {
    this.tracesFile = tracesFile;
  }

  async fetchFailedTraces({ limit = 200 } = {}) {
    const { readJsonl } = require('./util');
    const fs = require('fs');
    if (!fs.existsSync(this.tracesFile)) return [];
    const all = readJsonl(this.tracesFile).map((t) => assertTrace(t, this.tracesFile));
    return all.filter((t) => t.evaluatorExplanations.length > 0 || Object.values(t.evaluatorScores).some((s) => typeof s === 'number' && s < 0.5)).slice(0, limit);
  }

  async fetchExplanations(trace) {
    return trace.evaluatorExplanations.map((e) => `${e.evaluator}: ${e.explanation}`).join('\n') || 'No evaluator explanations recorded.';
  }

  async pushExperimentResult({ runId }) {
    return { ack: true, runId, sink: 'file' };
  }
}

/**
 * MockAdapter: fully offline, no LLM, no network. Serves a canned set of
 * failing traces and writes results to the ledger. Used by `--mock` mode.
 */
class MockAdapter {
  async fetchFailedTraces({ limit = 200 } = {}) {
    const traces = mockTraces();
    return traces.slice(0, limit);
  }
  async fetchExplanations(trace) {
    return trace.evaluatorExplanations.map((e) => `${e.evaluator}: ${e.explanation}`).join('\n');
  }
  async pushExperimentResult({ runId }) {
    return { ack: true, runId, sink: 'mock' };
  }
}

function mockTraces() {
  // The mock corpus mirrors the dogfood example's sources so reruns
  // reproduce the failure modes (some sources deliberately don't answer).
  const S1 = [{ id: 'source-1', title: 'Q1 Financial Summary', text: 'Q1 revenue was 10.2M USD, up 3% quarter over quarter. Churn held at 2.1%. Enterprise segment grew 11%.' }];
  const S_UNRELATED = [
    { id: 'source-1', title: 'Q1 Financial Summary', text: 'Q1 revenue was 10.2M USD, up 3% quarter over quarter. Churn held at 2.1%.' },
    { id: 'source-3', title: 'API Documentation', text: 'Standard plan rate limit: 600 requests per minute.' },
  ];
  const S4 = [{ id: 'source-4', title: 'Outage Postmortem', text: 'The March 3 outage lasted 47 minutes and affected EU-West. Root cause: a bad config push. Compensation: 10% credit on the next invoice.' }];
  const S3 = [{ id: 'source-3', title: 'API Documentation', text: 'Standard plan rate limit: 600 requests per minute. Enterprise plan: 5000 requests per minute.' }];
  const S2 = [{ id: 'source-2', title: 'Refund Policy', text: 'Refunds are available within 30 days of purchase for annual plans.' }];

  const mk = (id, input, output, source, evaluator, explanation, score) => assertTrace({
    id,
    agentInput: input,
    agentOutput: output,
    source,
    evaluatorScores: { [evaluator]: score },
    evaluatorExplanations: [{ evaluator, explanation }],
    metadata: { source: 'mock' },
  }, 'mock');
  return [
    mk('m1', 'Summarize the quarterly report', 'The report covers Q1: revenue 10M, up 3%. Sources: none cited.', S1, 'grounding', 'Output makes revenue claims with no source citations; evaluator requires inline source refs.', 0.2),
    mk('m2', 'Explain our refund policy from the handbook', 'Refunds are always available within 365 days per page 4.', S_UNRELATED, 'grounding', 'Claim contradicts source doc: refunds window is 30 days. Hallucinated detail (365 days, page 4).', 0.1),
    mk('m3', 'Draft a customer email about the outage', 'Dear customer, the outage is fixed. [no mention of compensation or timeline]', S4, 'policy', 'Missing required policy element: compensation credit mention. Tone acceptable.', 0.4),
    mk('m4', 'List API rate limits from the docs page', 'Rate limits are 1000 req/min for all plans.', S3, 'grounding', 'Wrong value: docs say 600 req/min standard plan, 5000 enterprise. Unsupported generalization.', 0.15),
    mk('m5', 'Summarize meeting notes', 'Team decided to ship Friday. Followups: none.', S1, 'grounding', 'Dropped action items section entirely; summary incomplete relative to notes.', 0.3),
    mk('m6', 'Draft a customer email about the billing error', 'Sorry about the billing error. Nothing else.', S2, 'policy', 'Missing required policy element: apology escalation path and ticket reference.', 0.35),
  ];
}

function getAdapter(config) {
  const src = config.source || {};
  const env = src.env || {};
  const get = (name) => (name ? process.env[name] : undefined);
  switch (src.adapter) {
    case 'phoenix':
      return new PhoenixAdapter({ endpoint: get(env.endpoint), apiKey: get(env.apiKey), projectName: src.projectName });
    case 'langfuse':
      return new LangfuseAdapter({
        endpoint: get(env.endpoint),
        apiKey: get(env.apiKey),
        publicKey: get(env.publicKey),
      });
    case 'file':
      return new FileAdapter({ tracesFile: src.tracesFile });
    case 'mock':
      return new MockAdapter();
    default:
      throw new AdapterError(`Unknown adapter '${src.adapter}'. Expected one of: phoenix, langfuse, file, mock.`);
  }
}

module.exports = {
  getAdapter,
  PhoenixAdapter,
  LangfuseAdapter,
  FileAdapter,
  MockAdapter,
  assertTrace,
  redact,
  redactTrace,
  AdapterError,
};
