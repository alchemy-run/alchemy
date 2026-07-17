# Alchemy AI — design index

Purpose: the entry point for refreshing context on the Alchemy AI
design. Read this file first; it tells you what is canon, what order to
read in, and what every document is for.

## Canon and current state

**The canon is [business-processes.md](./business-processes.md)**
(v4.1, "the resting point", July 2026). Where any other document
disagrees with it, the other document is stale. The one-paragraph
version:

Two worlds, one seam. Deterministic code (APIs, webhooks, validation,
**denial**, routing, your database, cron, projections) lives outside.
Processes are **actors whose behavior can be written in prose** — or
model-written code (codemode), or plain Effect code — interchangeable
Layers behind one tag. A run is an actor: created by its first message
(`dispatch` = ask, `send` = tell), steered by `steer(runKey, msg)`,
producing Actions (tool calls) and Messages (typed
`ctx.emit(EventSource, payload)`), settled by an exit. Terms are
declarations; what appears in a template is an Expression, and an
**unmarked reference grants the term's affordance** (`${Tool}` = may
call, `${Event}` = may publish — owner-sensitive: world-owned catalog
events afford nothing and render as vocabulary), while marked
expressions declare the signature: `${AI.when(X)}` accepts a broadcast
message (**no auto-delivery** — delivery is always code you can read),
`AI.until(schema)` / `AI.until(source, match)` / `AI.never` settle the
run. Alchemy **Resources are expressions** too — resolved identity +
dependency edge, no capability grant — and providers expose **scoped
event sources** (`GitHub.IssueOpened(repo)`) for per-resource
charters. **Implementations own delivery**: a process declares a
domain interface (`AI.Process<Self, Interface>`) and is implemented by
`Layer.effect(Term, …)` over seam services (event arrival, `Ledger`
dedupe, kernel); environments (local polling vs Cloudflare webhooks +
D1 + Durable Objects) are Layer provide-lists — see
`services/alchemy-org` and the software-factory plan. State lives in your DB or as folds over the Trace. DDD/Event
Storming are embedded patterns, never constructs. Removed concepts
(with reasons): business-processes.md §3; the signature reduction
(`on`→`when`, `AI.emit` subsumed by mention, `each`/`every` deleted):
§2a.

## Reading order for a context refresh

1. [business-processes.md](./business-processes.md) — the canon.
2. [alchemy-ai-design.md](./alchemy-ai-design.md) — the master design:
   term language, kernel contract, Trace, durability, serving,
   Cloudflare harness. Historical vocabulary preserved; dated
   reassessment sections record what changed.
3. [reports/agent-loop-algebra.md](./reports/agent-loop-algebra.md) —
   the formal model (Process ≅ Channel; Agent ⊂ Process; the
   eliminations), with the actor/message reading as a v2 addendum.
4. [reports/bp-kernel-layers-codemode-skills.md](./reports/bp-kernel-layers-codemode-skills.md)
   — kernel decomposition (ToolMode / CodeExecutor seams), codemode end
   to end (local + durable via Trace-as-ledger; no effect/workflow),
   Skills, protocol tools as terms, KernelPrompts dissolution.
5. [reports/bp-dx-open-source-org.md](./reports/bp-dx-open-source-org.md)
   — the target DX: running an open-source org (issues, PRs, Discord,
   releases) on these primitives; front-door doctrine; file layout.
6. [reports/bp-prose-authoring.md](./reports/bp-prose-authoring.md) —
   how to write charter prose; every splice earns a sentence.
7. Skim the rest as needed (map below).
8. Then the code: `packages/alchemy/src/AI/` (Process, Agent, Tool,
   EventSource, Trigger, Halt, Kernel, KernelMemory, Render,
   ProcessContext) and the tutorial example
   `examples/agent-chat-web/` (org.ts, server.ts).

## Document map

### Root design docs

| File | What it is |
|---|---|
| [business-processes.md](./business-processes.md) | **Canon.** The resting-point model, actor mapping, term surface, removed-concepts ledger, doctrine, build order. |
| [alchemy-ai-design.md](./alchemy-ai-design.md) | Master design document — vision, term language, kernel interface, Trace/durability, loop taxonomy, serving tiers, Cloudflare phases. |
| [serving.md](./serving.md) | Serving tier: how processes/agents are exposed over HTTP/WS, sessions, admission. |
| [chat-apps.md](./chat-apps.md) | Chat application patterns on top of the serving tier. |
| [org-chat.md](./org-chat.md) | The org-chat tutorial narrative (multi-channel org example). |
| [reassess-proposal.md](./reassess-proposal.md) | Reassessment round 1 synthesis (control refs, exit sources, deterministic paths, dynamic prose) — built; historical. |
| [example-claude-code.js](./example-claude-code.js) | Reference transcript/example artifact. |

### Business-process reports (round 2, July 2026)

| File | What it is |
|---|---|
| [reports/bp-ddd-event-storming.md](./reports/bp-ddd-event-storming.md) | DDD/Event Storming research; history of the entity/command/state excursion and why it was rejected; embedded-patterns chapter. |
| [reports/bp-dx-open-source-org.md](./reports/bp-dx-open-source-org.md) | OSS-org DX proposal: process catalog, front door, agent roster, responsibility layout, capability packages, gap list. |
| [reports/bp-kernel-layers-codemode-skills.md](./reports/bp-kernel-layers-codemode-skills.md) | Kernel layering, codemode design, Skills, protocol-tool terms. |
| [reports/bp-codemode-prior-art.md](./reports/bp-codemode-prior-art.md) | Source-level codemode survey: opencode, Codex, eve, Cloudflare, smolagents, Rig. |
| [reports/bp-prose-authoring.md](./reports/bp-prose-authoring.md) | Prose authoring guide: principles, per-term playbooks, BEFORE/AFTER rewrites, renderer findings. |

### Reassessment round 1 reports (built; historical)

| File | What it is |
|---|---|
| [reports/reassess-proposal… see root](./reassess-proposal.md) | Synthesis of the five below. |
| [reports/reassess-control-refs.md](./reports/reassess-control-refs.md) / [v2](./reports/reassess-control-refs-v2.md) | Control refs (`AI.until`/`AI.check`/…) as splices vs options. |
| [reports/reassess-exit-conditions.md](./reports/reassess-exit-conditions.md) | Exit-source taxonomy (model-declared, machine-observed, perpetual). |
| [reports/reassess-deterministic-orchestration.md](./reports/reassess-deterministic-orchestration.md) | Deterministic handlers/orchestration inside the process abstraction. |
| [reports/reassess-process-abstraction.md](./reports/reassess-process-abstraction.md) | Process vs Agent unification analysis. |
| [reports/dynamic-prose-and-tools.md](./reports/dynamic-prose-and-tools.md) | Dynamic prose/tool exposure analysis. |
| [reports/agent-loop-algebra.md](./reports/agent-loop-algebra.md) | The formal algebra of loops/processes; actor reading addendum. |
| [reports/perpetual-vs-goal.md](./reports/perpetual-vs-goal.md) | Perpetual vs goal-directed loops. |

### Framework surveys (background research)

| File | What it is |
|---|---|
| [reports/effect-ai.md](./reports/effect-ai.md) | Survey of @effect/ai. |
| [reports/ai-sdk.md](./reports/ai-sdk.md), [codex.md](./reports/codex.md), [opencode.md](./reports/opencode.md), [mastra.md](./reports/mastra.md), [eve.md](./reports/eve.md), [pi.md](./reports/pi.md), [flue.md](./reports/flue.md), [vercel-academy.md](./reports/vercel-academy.md) | Per-framework deep dives (Vercel AI SDK, Codex, opencode, Mastra, eve, pi, flue, Vercel agent academy). |
| [reports/effect-ai-mapping-*.md](./reports/) | How each surveyed framework's concepts map onto Effect/Alchemy. |
| [reports/bindings-architecture.md](./reports/bindings-architecture.md) | How AI terms integrate with Alchemy's binding architecture. |

## Where the code lives

- `packages/alchemy/src/AI/` — the abstraction: `Process.ts`,
  `Agent.ts`, `Tool.ts`, `EventSource.ts`, `Signature.ts`
  (`AI.when`/`AI.until`/`AI.never` — the message signature),
  `ProcessContext.ts` (`ctx.emit`), `Kernel.ts` (contract),
  `KernelMemory.ts` (reference kernel), `Render.ts` (prose rendering),
  `Api/` (serving protocol).
- `examples/agent-chat-web/` — the tutorial example: `src/org.ts`
  (three channel processes: deterministic, AI-direct, machine-exit),
  `src/server.ts` (front door + serving).
- `packages/alchemy/test/AI/` — scripted kernel/term tests.
- `packages/alchemy/src/GitHub/RepositoryEventSource.ts` +
  `packages/alchemy/src/Cloudflare/Workers/GitHubRepositoryEventSource.ts`
  — the world-side event wire (front-door input).

## Build order (from the canon)

P0 (done): typed emit; effectful-constructor `AI.process`;
steer-by-run-key + per-item machine-exit correlation; auto-delivery
removal; the signature reduction (`AI.when`, mention = publish grant,
`Signature.ts`); example alignment. Then GitHub catalog promotion +
self-hosting vertical. P1: kernel seam refactor, codemode local,
Skills, `alchemy/Coding` capability package. P2/P3: durable codemode,
DO-per-run harness, the business-process tutorial. Details:
[business-processes.md §6](./business-processes.md).
