# Dispatch

One orchestrator agent that manages all your coding-agent threads. Instead of a
sidebar of randomly-named chats, tasks appear as live cards **inside** the one
conversation you're having — collapsed to a single git-log-style line
(`fix(r2): bound retry schedule in bucket tests`), expandable to a thread peek.

## Run it

Requires [Bun](https://bun.sh) and a logged-in `claude` CLI (Claude Code).

```sh
cd apps/dispatch
bun install
bun dev          # → http://localhost:5170
```

By default workers operate on this repository (the workspace root). Point it
elsewhere with:

```sh
DISPATCH_WORKSPACE=~/code/my-other-repo bun dev
```

Try: *"kick off a fix for the flaky R2 tests, and draft release notes for the
last three merged PRs"* — two cards appear; expand one; when a worker gets
blocked it asks inline on its card.

## How it works

```
Browser (React)  ── SSE /api/stream ──  Bun server
                                          ├─ orchestrator: persistent Claude Code session
                                          │    tools: spawn_task · message_task · read_task
                                          │           list_tasks · stop_task   (in-process MCP)
                                          ├─ task manager + store (conversation, cards)
                                          └─ workers: one Claude Code session per task
                                               (Claude Agent SDK, local cwd, your claude login)
```

- **The orchestrator never codes.** Its only tools are the dispatch tools; all
  work is delegated to worker sessions.
- **Two wake sources.** You send a message, or a task transition
  (done / failed / needs_input) injects a `[task-event]` message. Wake turns
  answer `[silent]` unless something needs you — the server suppresses those,
  which is what keeps the feed calm.
- **needs-input round trip.** Workers get an `ask_user` MCP tool; in `safe`
  autonomy mode, gated tool calls (`canUseTool`) also surface as a card
  question (Allow once / Always allow / Deny). Answers resolve a pending
  promise inside the worker session — the thread resumes in place.
- **Everything is an adapter.** `src/adapters/claudeCode.ts` implements
  `spawn/send/answer/stop` + an event stream. An OpenCode (`opencode serve`
  HTTP), Codex (`codex exec --json`), or `@ai-sdk/harness-*` adapter slots in
  behind the same interface. (We use the Claude Agent SDK directly rather than
  `@ai-sdk/harness-claude-code` because the harness stack currently requires a
  cloud sandbox provider — Dispatch runs against your local checkout.)

## How the structured card is constructed

Every card field has exactly one producer — no summarizer model in the loop:

| Tier | Fields | Producer |
| --- | --- | --- |
| **Intent** | `title` (conventional commit), `brief` | Authored by the orchestrator LLM once, at spawn, as schema-enforced tool args (`spawn_task` rejects titles that don't match `type(scope): summary`). The orchestrator holds the intent, so it names the thread — that's why cards read like a git log. |
| **Protocol** | `question`, `summary`, transcript | Verbatim from the worker's structured stream: `ask_user` args, `canUseTool` permission requests, and the per-turn `result` text. Never paraphrased. |
| **Telemetry** | `status`, `activity`, `filesTouched`, `toolCounts`, `diff`, `costUsd`, `turns`, durations | A pure reducer over Agent SDK stream messages (`reduce()` in the adapter), plus a debounced `git diff --numstat` against a spawn-time baseline. Deterministic and always current. |

The conversation itself mirrors the AI SDK UIMessage model: an entry is a list
of parts, `text` interleaved with `{ t: "task", taskId }` refs. Cards render
from the live task store (keyed by id), so a card spawned at 9:14 shows its
9:50 state in place — the same reconciliation rule as AI SDK data parts.

## Status / roadmap

Experiment-grade v1. Not yet done: persistence across server restarts
(conversation + cards are in-memory; worker sessions die with the server),
full-thread drill-in view, second adapter, multi-repo task routing.
