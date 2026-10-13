'use strict';
/**
 * Two-stage research-and-write agent (the system under test in the dogfood example).
 *
 * Stage 1 (research): naive keyword retrieval over a small source corpus.
 * Stage 2 (write): compose an answer from the retrieved source, following
 *   agent/prompt.txt.
 *
 * This version is deliberately flawed in a realistic way: the write prompt
 * asks for citations but never forbids asserting specifics the source lacks —
 * exactly the root-cause pattern the mock traces exhibit.
 */
const fs = require('fs');
const path = require('path');

const CORPUS = [
  { id: 'source-1', title: 'Q1 Financial Summary', text: 'Q1 revenue was 10.2M USD, up 3% quarter over quarter. Churn held at 2.1%. Enterprise segment grew 11%.' },
  { id: 'source-2', title: 'Refund Policy', text: 'Refunds are available within 30 days of purchase for annual plans and 14 days for monthly plans. Refunds are processed in 5 business days.' },
  { id: 'source-3', title: 'API Documentation', text: 'Standard plan rate limit: 600 requests per minute. Enterprise plan: 5000 requests per minute. WebSocket connections are not rate limited.' },
  { id: 'source-4', title: 'Outage Postmortem', text: 'The March 3 outage lasted 47 minutes and affected EU-West. Root cause: a bad config push. Compensation: 10% credit on the next invoice.' },
];

function retrieve(query) {
  const words = query.toLowerCase().match(/[a-z]+/g) || [];
  const scored = CORPUS.map((doc) => {
    const hay = (doc.title + ' ' + doc.text).toLowerCase();
    const hits = words.filter((w) => hay.includes(w)).length;
    return { doc, score: hits };
  }).sort((a, b) => b.score - a.score);
  return scored.slice(0, 2).map((s) => s.doc);
}

function loadPrompt() {
  const p = path.join(__dirname, 'prompt.txt');
  return fs.readFileSync(p, 'utf8');
}

/**
 * run({ input, source }) -> string
 * `source` overrides the built-in corpus in tests (the experiment runner
 * passes the same source the original trace recorded).
 */
async function run({ input, source }) {
  const prompt = loadPrompt();
  const docs = source && source.length ? source : retrieve(input);
  const sourceBlock = docs.map((d) => `[${d.id}] ${d.title}: ${d.text}`).join('\n');

  // Stage 2: a tiny deterministic stand-in for the LLM write stage, faithful
  // to the flawed prompt (cites what it uses, but will happily assert
  // specifics it "remembers" — the failure mode under test). When the prompt
  // carries the tightened verbatim-only constraint (the proposed fix), the
  // agent declines instead of inventing.
  return composeAnswer(input, docs, prompt);
}

/**
 * Deterministic mock "LLM": answer from the retrieved docs when they clearly
 * contain relevant facts; otherwise either invent a plausible answer (flawed
 * prompt) or explicitly decline (fixed prompt with the verbatim constraint).
 */
function composeAnswer(input, docs, prompt) {
  const strict = /never state|verbatim/i.test(prompt || '');
  const q = input.toLowerCase();
  const hasRelevant = docs.some((d) => {
    const words = q.match(/[a-z]+/g) || [];
    return words.some((w) => w.length > 4 && (d.title + ' ' + d.text).toLowerCase().includes(w));
  });

  if (!hasRelevant) {
    if (strict) return "I don't know — the provided sources do not contain this information.";
    // The flawed behavior: inventing a plausible-sounding answer with
    // confident-sounding specifics instead of declining.
    if (/refund/.test(q)) return 'Refunds are available within 365 days per page 4 of the handbook. [source 2]';
    if (/rate limit/.test(q)) return 'Rate limits are 1000 requests per minute for all plans. [source 3]';
    if (/meeting|decision/.test(q)) return 'The team decided to ship Friday. Followups: none.';
    return 'Based on general knowledge, the relevant figure is approximately 1.8% and this is well documented.';
  }

  const first = docs[0];
  const sentence = first.text.split('. ')[0];
  return `${sentence}. [${first.id}]`;
}

module.exports = { run, retrieve, composeAnswer, CORPUS };
