'use strict';
/**
 * Dogfood evaluators: grounding + policy-completeness. Deliberately simple
 * and deterministic so the offline demo is reproducible.
 *
 * grounding: does every specific claim trace to the provided source?
 * policy:    when the source cannot answer, the agent must decline explicitly
 *            instead of inventing; when it answers, it must cite.
 */
function specifics(text) {
  // numbers, page refs, percentages — the things that must be traceable
  const out = [];
  for (const m of text.matchAll(/\b\d+(?:\.\d+)?\s*%|\b\d+(?:\.\d+)?[kKmM]?\b|\bpage\s+\d+\b|\b\d+\s*(?:days?|hours?|business days?)\b/gi)) {
    out.push(m[0].toLowerCase());
  }
  return out;
}

function sourceText(docs) {
  return (docs || []).map((d) => (d.text || '')).join(' ').toLowerCase();
}

const grounding = {
  name: 'grounding',
  evaluate: async ({ output, source }) => {
    if (!output) return { score: 0, explanation: 'Agent returned no output.' };
    const hay = sourceText(source) || '';
    if (!hay) return { score: 0.5, explanation: 'No source available to verify claims against.' };
    const unsupported = specifics(output).filter((s) => !hay.includes(s.replace(/\s*%/, '%')));
    if (unsupported.length === 0) return { score: 1, explanation: 'All specific claims are supported by the source.' };
    return {
      score: Math.max(0, 1 - unsupported.length * 0.4),
      explanation: `Output asserts specifics not in source: ${unsupported.join(', ')}.`,
    };
  },
};

const policy = {
  name: 'policy',
  evaluate: async ({ output, input, source }) => {
    if (!output) return { score: 0, explanation: 'Agent returned no output.' };
    const q = (input || '').toLowerCase();
    const hay = sourceText(source);
    if (!hay) {
      // Without the source we can only check the citation convention.
      return /\[(source-\d+)\]|\[source \d+\]/.test(output)
        ? { score: 1, explanation: 'Cites a source (cannot verify answerability without the source).' }
        : { score: 0.6, explanation: 'Missing required policy element: inline source citation.' };
    }
    // If the question is answerable from source, require a citation.
    if (specifics(output).length) {
      const cites = /\[(source-\d+)\]|\[source \d+\]/.test(output);
      if (!cites) return { score: 0.6, explanation: 'Missing required policy element: inline source citation.' };
    }
    // If the source cannot answer, require explicit decline, not invention.
    const answerable = (q.match(/[a-z]+/g) || []).some((w) => w.length > 4 && hay.includes(w));
    if (!answerable && !/don't know|do not know|not contained|cannot find|no information/i.test(output)) {
      return { score: 0.3, explanation: 'Source does not answer the question; policy requires declining instead of inventing.' };
    }
    return { score: 1, explanation: 'Output meets policy requirements.' };
  },
};

module.exports = { evaluators: [grounding, policy] };
