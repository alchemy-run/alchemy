# alchemy evals

Measures how well coding agents (harness × model) build, test, and deploy
real apps with alchemy, guided only by published docs. Full design:
`processes/Evals/eval-framework-plan.md` (main workspace).

## Run

Secrets come from Doppler (`alchemy-v2` / `dev`): `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `CLOUDFLARE_API_TOKEN`, `TEST_CLOUDFLARE_ACCOUNT_ID`.

```sh
cd evals

# 1. prove the pipeline with the reference solution (no agent, no LLM cost)
doppler run -p alchemy-v2 -c dev -- bun runner/main.ts run --task pastebin --oracle

# 2. real trial: enabled harnesses from evals.config.ts (claude-code × fable-5)
doppler run -p alchemy-v2 -c dev -- bun runner/main.ts run --task pastebin

# specific cell / more trials
doppler run -p alchemy-v2 -c dev -- bun runner/main.ts run --task pastebin --harness claude-code --model claude-fable-5 --trials 3

# results table (results/runs.jsonl)
bun runner/main.ts report
```

## Task modes

- **`user`** (the default going forward): PROMPT.md is a few sentences in the
  customer's voice (e.g. `pastebin-web`: "Build me a pastebin with a TanStack
  Start frontend..."). No pinned API contract — grading happens at the product
  level: a **verifier agent** (headless Claude, curl/fetch only, no source
  access) probes the deployed app against the hidden `verify/intent.md` and
  emits pass/fail per intent check with evidence.
- **`spec`**: pinned API contract graded by deterministic `verify/checks.ts`
  (kept for API-explicit products and as pipeline canaries — `pastebin`).

## Docs iteration (the flywheel axis)

The docs pointer rendered into every prompt is a runner input, recorded per
trial:

```sh
# A/B a docs edit: deploy the website from your branch, point a wave at it
cd website && bun alchemy deploy            # -> workers.dev preview URL
bun runner/main.ts run --task pastebin-web --docs-url https://<preview>.workers.dev
```

SKILL.md is a separate locally-injected condition (C3) layered on either docs URL.

## Layout

- `evals.config.ts` — harness × model matrix (all four adapters built; only
  claude-code enabled until codex/opencode/pi auth is verified), trials, budgets.
- `runner/` — plain bun TS orchestration: adapters, workspace provisioning,
  verify pyramid, journaling. Task templates/oracles/tests are Effect-native.
- `tasks/<id>/` — `task.json`, `PROMPT.md` (`{{STAGE}}`/`{{DOCS}}` rendered at
  provision), `template/` (agent starting point — deliberately mirrors the
  real getting-started flow: deps installed, tsconfig, NOTHING else; no stub
  Stack, no seed tests, so the docs must teach everything we grade),
  `verify/` (hidden `checks.ts` or `intent.md`, never copied into
  workspaces), `answer/` (oracle overlay).
- `results/` — gitignored `runs.jsonl` + `journal.jsonl`.

## Isolation

Trial workspaces live in `~/.cache/alchemy-evals/runs/<runId>/` — outside the
repo so harnesses can't inherit the monorepo's CLAUDE.md/AGENTS.md. Claude Code
gets a fresh `CLAUDE_CONFIG_DIR` per run (auth via `ANTHROPIC_API_KEY`). Each
trial deploys to stage `e<runId>` with `Alchemy.localState()`; the grader
re-deploys (idempotence), probes health, runs hidden checks, re-runs the
agent's tests, then destroys.
