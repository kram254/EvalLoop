---
name: evalloop
description: Close the eval loop for LLM agents — pull failed traces from Phoenix/Langfuse, cluster root causes, propose prompt patches, and verify with a controlled before/after experiment. Use when the user wants to debug agent failures, improve agent quality, run eval-driven prompt iteration, or set up an eval-fix-verify workflow.
---

# EvalLoop — failed traces → clustered root causes → verified prompt fixes

EvalLoop is a CLI (`evalloop`, zero runtime dependencies, Node ≥ 22.5) plus this
skill contract. It turns *failing evaluator explanations* into *one verified
prompt/config patch*, and never proposes a change unless scores improve.

## When to use which command

| Situation | Command |
|---|---|
| First time in a repo | `evalloop init <root>` — writes config, evaluator template, REQUIREMENTS.md |
| Investigating why an agent fails | `evalloop pull` then `evalloop cluster` |
| Ready to change prompts | `evalloop propose` |
| Verifying a proposal | `evalloop experiment` |
| Whole cycle in one shot | `evalloop loop` |
| Offline demo / CI smoke test | `evalloop loop . --mock` |

Run all commands from (or pointed at) the **repo root** that contains
`evalloop.config.json`, `agent/`, `evals/`, and `traces/`.

## The one-command path

```
evalloop loop .            # live: real traces from the configured adapter
evalloop loop . --mock     # offline demo with canned data
```

`loop` runs: pull → cluster → propose → experiment, and prints a before/after
table with **dev and held-out reported separately**, plus a REJECT/PROPOSE
recommendation. Never auto-merges; the user reviews and applies the diff:

```
git apply < .evalloop/<runId>/proposal.diff
```

## Configuration (evalloop.config.json)

- `source.adapter`: `phoenix` | `langfuse` | `file` | `mock`; env-var names for
  endpoints/keys are read from the environment (never stored in config).
- `severity`: USER-set 1–5 severity per root-cause category name; unknown
  categories fall back to `default`. `priority = frequency × severity`.
- `split.devRatio`: default 0.75 → 75% dev / 25% held-out, deterministic seed.
- `repo.exclude`: never scanned, never patched (eval data, datasets, fixtures).
  `.evalloop/`, `node_modules/`, `.git/` are always excluded.

## Hard rules (enforced by code, not convention)

1. **Held-out isolation.** The proposer sees only the cluster summary (name,
   description, example codes) — never held-out traces. Held-out traces are
   first touched by the experiment runner, after the patch is already written.
2. **No eval data in prompts.** The proposal schema forces an explicit
   `antiCheatChecklist`; the scanner and diff applier refuse excluded paths.
3. **Requirements over evals.** REQUIREMENTS.md is injected into the proposer
   so fixes serve real product goals, not just passing evals.
4. **Regression guard.** `traces/regression.jsonl` (past passes) is rerun; a
   dev improvement with a regression-set drop is a REJECT (overfitting).
5. **Stale diffs are rejects.** If the diff doesn't apply cleanly, the patch
   counts as not applied, not as "no change".

## When Claude Code should invoke this skill

- The user reports agent quality problems and their org logs traces to
  Phoenix, Langfuse, or Arize AX: start with `init` + `pull`.
- The user is iterating on prompts and wants evidence before merging:
  run `propose` + `experiment`, then present the report.
- The user asks "did my prompt change actually help?": run `experiment` —
  it always reports held-out separately from dev.

## Integration contract (for wiring your own source)

Implement and register in `src/adapters.js`:

```js
fetchFailedTraces({ limit })        // -> [trace]
fetchExplanations(trace)            // -> string
pushExperimentResult({ runId, report }) // -> ack
```

Trace shape: `{ id, agentInput, agentOutput, steps, evaluatorScores,
evaluatorExplanations: [{evaluator, explanation}], metadata }`. Secrets come
from `process.env` only.

## Failure modes to flag to the user

- `ANTHROPIC_API_KEY` missing → clustering/propose cannot run; suggest `--mock`.
- No regression dataset → the overfitting guard is off; warn, don't guess.
- Empty clusters or 0 traces → check the adapter endpoint and evaluator score
  conventions (failure = any explanation present, or any score < 0.5).
