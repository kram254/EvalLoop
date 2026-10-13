'use strict';
/**
 * Repo scanner: finds prompt / retrieval-config / tool-definition files the
 * fix proposer may read or patch. HARD GUARDRAILS (anti-cheat):
 *   - Never traverses excluded paths (eval data, datasets, fixtures, .evalloop,
 *     held-out material). These are merged from config.repo.exclude.
 *   - Never returns file CONTENT for excluded paths, even if globbed directly.
 *   - Caps results (config.limits.maxPatchFiles candidates of each kind).
 */
const fs = require('fs');
const path = require('path');

function toRel(abs, root) {
  return path.relative(root, abs).split(path.sep).join('/');
}

/** Minimal glob-to-regexp supporting **, *, and {a,b} alternation. */
function globToRe(glob) {
  let g = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '(?:.*)?')
    .replace(/\{([^}]+)\}/g, (_, alts) => `(${alts.split(',').join('|')})`);
  // Anchor at start; `**/` should also match a top-level path segment.
  g = g.replace(/^\(\?:\.\*\)\?\//, '(?:.*/)?');
  return new RegExp('^' + g + '$');
}

function buildExcludes(config) {
  const patterns = [...(config.repo.exclude || [])];
  // Always-on guardrails, regardless of config: run state, dependencies,
  // VCS internals, and test/fixture material are never scanned or patched.
  patterns.push('**/.evalloop/**', '**/node_modules/**', '**/.git/**', '**/test/**', '**/tests/**', '**/fixtures/**');
  return patterns.map(globToRe);
}

function walk(dir, root, excludes, out, depth = 0) {
  if (depth > 12) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    const rel = toRel(abs, root);
    if (excludes.some((re) => re.test(rel))) continue;
    if (e.isDirectory()) walk(abs, root, excludes, out, depth + 1);
    else if (e.isFile()) out.push({ abs, rel });
  }
}

/**
 * Scan the repo. Returns candidate files grouped as:
 *   prompts:    files whose content matches prompt hints or live in prompt dirs
 *   retrieval:  config-ish files mentioning retrieval/search/embedding/topK
 *   tools:      files defining tools (function-tool registries, tool schemas)
 * Each entry: { relPath, kind, preview (first matching lines), size }
 */
function scanRepo(root, config) {
  const repoRoot = path.resolve(root, config.repo.root || '.');
  const excludes = buildExcludes(config);
  const files = [];
  walk(repoRoot, repoRoot, excludes, files);

  const hints = (config.repo.promptHints || ['prompt', 'system_prompt', 'instructions', 'TEMPLATE']).map((h) => h.toLowerCase());
  const retrievalRe = /\b(retriev|top_?k|topk|embedding|vector|search|rerank|chunk)\b/i;
  const toolsRe = /\b(tool|function_call|tools\s*[:=]|name:\s*['"])/i;

  const prompts = [];
  const retrieval = [];
  const tools = [];
  const cap = (config.limits && config.limits.maxPatchFiles) || 3;

  for (const f of files) {
    let content;
    try {
      if (fs.statSync(f.abs).size > 512 * 1024) continue;
      content = fs.readFileSync(f.abs, 'utf8');
    } catch {
      continue;
    }
    const lower = content.toLowerCase();
    const rel = f.rel;
    const lines = content.split('\n');

    const preview = (re) => {
      const i = lines.findIndex((l) => re.test(l));
      return i >= 0 ? lines[i].trim().slice(0, 160) : '';
    };

    const isNamedPrompt = /(^|\/)(prompts?|templates?)(\/|$)/i.test(rel) || /prompt|template/i.test(path.basename(rel));
    if (hints.some((h) => lower.includes(h)) || isNamedPrompt) {
      prompts.push({ relPath: rel, kind: 'prompt', isNamedPrompt, preview: preview(/prompt|instruction|template|system/i), size: content.length, lines: lines.length });
    } else if (retrievalRe.test(content) && /\.(ya?ml|json|js|ts|py|toml)$/i.test(rel)) {
      retrieval.push({ relPath: rel, kind: 'retrieval', preview: preview(retrievalRe), size: content.length, lines: lines.length });
    } else if (toolsRe.test(content) && /\.(js|ts|py|json)$/i.test(rel)) {
      tools.push({ relPath: rel, kind: 'tool-definition', preview: preview(toolsRe), size: content.length, lines: lines.length });
    }
  }

  const bySize = (a, b) => b.size - a.size;
  // Actual prompt files (named/dirs as prompts) outrank files that merely
  // mention prompt-ish words; then by size.
  prompts.sort((a, b) => (b.isNamedPrompt - a.isNamedPrompt) || bySize(a, b));
  retrieval.sort(bySize); tools.sort(bySize);
  return {
    prompts: prompts.slice(0, cap * 3),
    retrieval: retrieval.slice(0, cap * 2),
    tools: tools.slice(0, cap * 2),
    scannedCount: files.length,
  };
}

module.exports = { scanRepo, globToRe, buildExcludes };
