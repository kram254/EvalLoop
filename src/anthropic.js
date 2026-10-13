'use strict';
/**
 * Anthropic API client (zero-dependency, Node >= 22.5 built-in fetch).
 * - Sonnet for analysis (clustering, patch proposal)
 * - Haiku for bulk classification / lightweight reruns
 * - Tool use is the ONLY structured-output mechanism: every call forces a
 *   single tool with an input_schema, so responses are schema-valid JSON.
 * - Retries on 429/5xx with exponential backoff.
 */
const { postJson } = require('./util');

const DEFAULT_BASE = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
const SONNET = process.env.EVALLOOP_SONNET_MODEL || 'claude-sonnet-4-5';
const HAIKU = process.env.EVALLOOP_HAIKU_MODEL || 'claude-haiku-4-5';

function anthropicKey() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. EvalLoop needs it for clustering and patch generation. ' +
      'For a fully offline demo, run with --mock.'
    );
  }
  return key;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Send a message that MUST answer by calling exactly one tool (forced choice),
 * returning the parsed tool input object.
 */
async function extractJson({ system, messages, schema, toolName = 'emit_json', model = 'sonnet', maxTokens = 8192, apiKey = anthropicKey() }) {
  const modelId = model === 'haiku' ? HAIKU : SONNET;
  const body = {
    model: modelId,
    max_tokens: maxTokens,
    system,
    messages,
    tools: [{ name: toolName, description: 'Emit the structured result', input_schema: schema }],
    tool_choice: { type: 'tool', name: toolName },
  };
  const maxAttempts = 4;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await postJson(`${DEFAULT_BASE}/v1/messages`, body, {
        apiKey,
        anthropicVersion: '2023-06-01',
        timeoutMs: 180000,
      });
      const block = (res.content || []).find((b) => b.type === 'tool_use');
      if (!block) throw new Error('Model did not return a tool_use block: ' + JSON.stringify(res.content).slice(0, 300));
      return block.input;
    } catch (err) {
      lastErr = err;
      const retryable = err.status === 429 || (err.status >= 500 && err.status < 600) || err.name === 'AbortError';
      if (!retryable || attempt === maxAttempts) throw err;
      await sleep(1000 * Math.pow(2, attempt - 1));
    }
  }
  throw lastErr;
}

module.exports = { extractJson, SONNET, HAIKU, anthropicKey };
