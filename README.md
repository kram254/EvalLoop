# EvalLoop

Close the loop from **failed LLM-agent traces** to **verified prompt fixes**:
pull traces with evaluator explanations → cluster root causes → propose one
patch addressing the top pattern → rerun a controlled before/after experiment
→ **propose changes only if scores improve**.

Zero runtime dependencies (Node ≥ 22.5, built-in `fetch` + `node:sqlite`).
Install with `npx` — no build step.

## 5-minute quickstart

```bash
# 1. Get it (from this directory, or via npx once published)
npm link            # exposes `evalloop` on your PATH
# …or run directly: node bin/evalloop.js <command>

# 2. Offline demo — no keys, no network, ~2 seconds
evalloop loop . --mock
```

You'll see clustered root causes, a unified diff proposal, and a before/after
score table with **dev and held-out sets reported separately**.

## Going live

```bash
evalloop init .                # writes evalloop.config.json, evaluators, REQUIREMENTS.md

# Point it at your tracing vendor (Phoenix shown; Langfuse also supported)
export PHOENIX_ENDPOINT=https://your-phoenix.internal
export PHOENIX_API_KEY=...
export ANTHROPIC_API_KEY=sk-ant-...      # Sonnet for analysis, Haiku for bulk coding

evalloop pull                  # fetch failed traces
evalloop cluster               # open coding (Haiku) + axial coding (Sonnet)
evalloop propose               # scan repo, emit unified diff for the TOP cluster
evalloop experiment            # 75/25 dev/held-out + regression rerun, before/after
# …or all of it: evalloop loop .
```

Apply a proposal yourself after review — nothing is ever auto-merged:

```bash
git apply < .evalloop/<runId>/proposal.diff
```

## What's in the box

```
evalloop/
├── bin/evalloop.js          # CLI entry
├── src/
│   ├── cli.js               # commands: init status pull cluster propose experiment loop
│   ├── adapters.js          # Phoenix, Langfuse, file, mock + trace contract
│   ├── cluster.js           # open coding → axial coding → priority = freq × severity
│   ├── proposer.js          # repo-aware unified-diff fix proposals
│   ├── scanner.js           # prompt/retrieval/tool discovery (with exclusions)
│   ├── runner.js            # 75/25 split, regression guard, before/after report
│   ├── store.js             # append-only ledger under .evalloop/
│   ├── config.js            # evalloop.config.json
│   └── util.js              # fetch, JSONL, deterministic shuffle, diff applier
├── agent/                   # dogfood: two-stage research-and-write agent
│   ├── agent.js
│   └── prompt.txt
├── evals/evaluators.js      # grounding + policy evaluators
├── traces/                  # demo failure + regression datasets (JSONL)
├── test/                    # offline unit + integration tests
├── SKILL.md                 # Claude Code skill contract
└── README.md
```

## Guardrails (enforced in code)

- **Held-out isolation** — the fixer never sees held-out traces; the split is
  applied only inside the experiment runner, after the patch is written.
- **No test data in prompts** — the proposer's schema forces an explicit
  anti-cheat checklist; scanner and diff applier refuse excluded paths.
- **Requirements file** — `REQUIREMENTS.md` is injected into the proposer so
  fixes optimize real goals, not just passing evals.
- **Regression dataset** — past passes (`traces/regression.jsonl`) are rerun;
  dev gains with regression drops are rejected as overfitting.
- **Stale diffs reject** — an unappliable patch counts as "not applied".

## Adapter contract

```js
fetchFailedTraces({ limit })            // → [trace]
fetchExplanations(trace)                // → string
pushExperimentResult({ runId, report }) // → ack
```

A trace: `{ id, agentInput, agentOutput, steps, evaluatorScores,
evaluatorExplanations, metadata }`. Arize AX can be added the same way.

## Non-goals

No tracing UI, no auto-merging. EvalLoop proposes; you decide.
