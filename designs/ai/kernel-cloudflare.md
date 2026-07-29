# KernelCloudflare — working notes

The second kernel: the same `Kernel.interpret(term, charter)` contract
as `KernelMemory`, hosted on Cloudflare Durable Objects. This is the
DIRECT implementation (v1) — deliberately a fork of KernelMemory's
internals where they transfer, restructured where the substrate
demands it. The generalization into swappable layers comes AFTER this
works and has taught us where the true seams are (tracked at the
bottom).

## The mapping

| KernelMemory | KernelCloudflare v1 |
|---|---|
| Actor = keyed map of RunStates in one process | Actor = a DO NAMESPACE; one DO instance per RUN, named `${term}/${key}` |
| run loop = perpetual fiber per run | BURST per event: drain → tick → sample → tools → repeat until quiescent, then return (DO may hibernate) |
| inbox = `Queue` | inbox = storage rows (`inbox:{seq}`), drained per burst |
| thread = `Prompt` in memory | thread = storage rows (`msg:{seq}`), one per message; rebuilt into a Prompt per burst |
| waiters ride inputs (Deferred) | v1: the dispatch RPC is HELD OPEN (parent pinned while child works — exact KernelMemory semantics). v2 (layering phase): durable continuations — the burst parks on outstanding tool results; replies arrive by `deliverReply` RPC and resume it |
| `Thread.remind` = kernel-scoped fiber | reminder rows + `storage.setAlarm(min fireAt)`; the `alarm()` handler enqueues due notes and re-arms |
| charter init once per RUN (closures live forever) | init once per ACTIVATION: re-runs after eviction, so `Ref`s made in init are ISOLATE state, not run state. Run-durable state lives in the thread (where the org already keeps it since the reply refactor removed the Ref dance) or in DO storage. The spec's "named-state Ref" is the eventual affordance |
| supervision children map | `children:{agent}:{key}` rows; cascade on settle/crash RPCs the children's DOs |
| `KernelObserver` per-run seq | same observations, seq persisted; sink = observer layer provided in the DO (log/Analytics/Chats-DO later) |

## The user surface (DECIDED 2026-07-27)

`KernelCloudflare` is a BARE CONST layer, the exact silhouette of
`KernelMemory` — no class to declare, no thunk, no `host` return.
Agents flow through the class-level `layers` slot; kernel ↔ agents is
one composed layer, provided once:

```ts
const OrgAgents = Layer.mergeAll(IssueOwnerLive, EngineerLayer, ReviewerLayer)
  .pipe(Layer.provideMerge(Model));

export default class OrgWorker extends Cloudflare.Worker<OrgWorker>()(
  "OrgWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const owner = yield* IssueOwner;
    yield* GitHub.consumeRepositoryEvents(testAlchemy, { events }, route(owner));
    return { fetch: /* status/board */ };
  }),
  OrgAgents.pipe(Layer.provideMerge(Cloudflare.AI.KernelCloudflare)),  // ← layers slot
) {}
```

Swapping kernels is one line: `KernelMemory` ↔ `KernelCloudflare`.

### Why no argument, no user class

The runs DO class is declared INSIDE the package (module scope), not
by the user. It resolves as an ordinary binding inside the returned
layer (`yield* InternalRunsDO`). Two mechanisms make the bare const
work:

1. **The `layers` slot is the isolate-shared build.** A Worker and its
   DO classes share one memoized layer build (WorkerBridge
   `getSharedBuild`); the class-level `layers` argument IS that build.
   Put `agents ⊕ kernel` there and the internal runs-DO resolves the
   SAME kernel service instance — charter registrations included —
   from its own init. (An `Effect.provide` inside the init effect is
   handler-local and invisible to DOs; the slot is the seam.)
2. **Charter registration rides the service instance.** `interpret`
   records `term → {charter, captured context}` on the kernel service
   (a symbol field, not module state). The DO reads it back via the
   same tag and becomes the run its name (`${term}/${key}`) addresses.

A charter is CODE and can't cross the wire — but it doesn't need to:
both the Worker (caller) and the runs DO build the SAME layer graph in
the SAME bundle, so the closures exist on both sides natively.

**OPEN (verify with a deploy):** that alchemy's binding inference +
entry generation discover a PACKAGE-internal DO class referenced only
via `yield*` inside a layer. If not, the fallback is a one-line
`export const OrgRuns = ...` the user re-exports — still no
user-authored class body, no circularity.

## Progress

- **KernelShared.ts** — the substrate-free helpers (`render`,
  `compile*`, message shapes, `Stance`/`CompiledToolRef`) extracted
  and imported by KernelMemory; 27 kernel tests green. The next
  shared tier (`renderStance`, `step`, `buildToolkit`, skill-graph
  fixpoint) parameterizes on `{model, provideRun}` — extract once the
  CF engine confirms the signatures (the "diff the two kernels" step).

## The burst (the loop, event-shaped)

```
on send/dispatch/steer RPC (or alarm):
  append input row(s)                        [durable before ack]
  if a burst is already running → return     [single-writer per DO]
  loop:
    inputs ← drain inbox rows
    if none and quiescent → PARK (return; alarm armed if reminders)
    tick: evaluate turn (registry charter; TickEvent{count, inputs})
    append note rows (AI.say), stance → system prompt
    sample (streamText; tool handlers run inside; AI.reply resolves
      open dispatch RPCs)
    append response rows; tick++
  crash mid-burst → inputs not yet consumed re-drain on next wake;
  appended messages stand (at-least-once, content-keyed dedupe)
```

Serial execution per run is free: DOs are single-threaded and
`blockConcurrencyWhile`/input-gates order events.

## Durability (v1.1 — after studying think)

DOs run long but not forever: evictions, deploys, and defects kill an
in-flight burst. The recovery design adapts
`@cloudflare/agents`' fiber machinery (see
[reports/think-durable-execution.md](./reports/think-durable-execution.md))
to the burst loop — same mechanics, smaller surface:

- **Liveness marker, not heartbeat** (`meta.busy`): written when a
  round opens, cleared at quiescence, reset (attempts → 0) by every
  completed sampling. A burst that finds it set on ENTRY knows its
  predecessor died — eviction, deploy, and crash are indistinguishable
  on disk and recovered identically. The burst gate makes the check
  unambiguous: a healthy predecessor clears the marker before
  releasing.
- **Self-arming recovery alarm**: the single DO alarm serves both
  clocks — `min(next reminder, busy.since + recoverAfter · 2^attempts)`
  — re-armed on every mutation and after every alarm-driven burst. A
  clientless DO with a broken round wakes itself; any ordinary event
  (deliver/steer/dispatch) recovers it sooner for free.
- **Progress-keyed attempt budget** (think's key insight): attempts
  count consecutive re-entries on the SAME round; any sampling that
  lands resets the budget, so long tool-looping rounds never exhaust.
  On exhaustion (default 5) the round is abandoned VISIBLY — an
  interruption note in the thread, a `crashed` observation — and the
  run keeps serving fresh input with a fresh budget.
- **Append-first drain with a watermark** (`meta.drained`): inputs are
  appended to the thread — watermark advanced, round opened — in ONE
  atomic write, and only then are inbox rows deleted. Rows below the
  watermark on redelivery are discarded, never re-appended:
  at-least-once drain, exactly-once append. `enqueue` writes its row
  and the seq bump atomically for the same reason.
- **No transcript repair needed**: a round's messages (tool results
  included) append only after its sampling completes, so partial
  rounds never persist — recovery re-samples; it never splices. The
  transcript stays pure (only model-produced content) and the cached
  prompt prefix stays byte-stable across recoveries. The cost is
  at-least-once TOOL side effects on recovery, mitigated by the
  **recovery note**: each re-entry appends a `<note>` telling the
  model the previous attempt was interrupted and to verify before
  repeating side effects — think's informed-re-decision property, at
  the tail of the thread instead of spliced into it. The next rung,
  when Engineer-scale non-idempotent steps run here, is a
  **tool-replay ledger** (Workflows-style `step.do` memoization of
  settled tool results), NOT partial persistence — full think-style
  within-step checkpointing + repair only earns its keep when
  streaming clients need resumption.
- `KernelDurability` (optional layer) tunes `recoverAfterMillis` /
  `maxAttempts`; tests run recovery at seconds.

Deliberately NOT taken from think: durable submissions/idempotency
ledger for `dispatch` (callers re-drive; the round itself is durable),
delivery-state snapshots (no streaming clients yet), and stash-based
mid-callback checkpoints (the round is our checkpoint grain).

## Live view: the run socket (v1.2)

Each run serves its own live view over HIBERNATABLE WebSockets —
four frame concepts, distilled from studying `@cloudflare/ai-chat`
(see [reports/cloudflare-chat-protocol.md](./reports/cloudflare-chat-protocol.md)),
whose five-frame resume handshake and full-replay-from-zero
chunk-buffer machinery all compensate for the absence of a cursor:

- **Durable observation rows** (`obs:{seq}`): every canonical
  observation is written as a row — the watermark bump in the same
  atomic put — before being fanned out. The run IS its own
  projection; no Chats DO, no external store.
- **Live observations** (`assistant-delta`, in-flight `tool-call`)
  broadcast without a row and without advancing the cursor — a
  reconnect misses them and the durable `assistant` restatement
  covers the gap. `tool-result`s ARE durable (outputs are not
  restated by `assistant`).
- **The protocol** (`AI/RunSocket.ts`, substrate-neutral):
  client → `subscribe {fromSeq}` (the ENTIRE resume story: replay
  rows ≥ cursor, then a `live` marker) and `submit {input}` (the
  socket's steer); server → `observation {durable, observation}`.
  The wire carries kernel vocabulary — UIMessage translation happens
  client-side (`RunSocketTransport`, an AI SDK `ChatTransport` for
  `useChat`, using `makeChunkTranslator`; step-granular in v1).
- **Hibernation-safe by construction**: no in-memory session map —
  `broadcast` re-reads `state.getWebSockets()` every time, so a
  DO woken by a frame has nothing to rehydrate. Sends are
  ignore-on-failure (`sendIfOpen` discipline): a dropped frame is a
  gap the client's cursor closes, never an error.
- **`AgentGateway`** (a CORE `AI` service, provided by BOTH kernels):
  the server-side door — `gateway.attach(term, key, request)` routes
  an `Upgrade: websocket` request to the run. `KernelCloudflare`
  forwards into the run's own DO; `KernelMemory` serves the socket
  in-process (each run keeps a ring-buffered observation log and a
  live socket set), so a local host speaks the IDENTICAL protocol.
  The frame handler itself is shared (`handleRunSocketFrame`) — the
  wire cannot drift between substrates.
- **React hooks, first-class** (`alchemy/AI/React` — a subpath so
  `react` never enters a Worker bundle): `useAgent({ url })` connects
  to a run; `useChat({ agent })` IS the AI SDK's `useChat` pre-wired
  with the run-socket transport — same return shape, ai-elements
  compatible, kernel-agnostic.

Kept from their scar tissue: sendIfOpen, cursor-only progress (no
protocol state in isolate memory). Deliberately dropped: resume
handshakes, chunk buffers + GC, tunneled-HTTP submit frames,
server-side UIMessage minting.

## v1 simplifications (accepted, revisit in layering)

1. **Held-open dispatch RPC** — parent and child pinned for the round.
   An in-isolate crash no longer touches the caller at all: waiters
   stay parked and RECOVERY answers them at quiescence (exhaustion is
   the one crash that fails them, visibly). An EVICTION still fails
   the call — the Deferred dies with the isolate — but no longer the
   round: the run recovers and the answer lands in the thread. A
   durable acceptance ledger (think's `startFiber` idempotency keys)
   is the v2 follow-up.
2. **No passivation snapshot beyond the thread** — `lastStance`,
   pending compaction etc. recompute per burst.
3. **Observer = log sink** — board/Chats projection on Cloudflare is
   its own follow-up (a Chats DO or Analytics Engine).
4. **Codemode/WireMode untested on DO** in v1.

## What we expect to extract in the layering phase

Candidates that look substrate-independent already (verify by diffing
the two kernels once v1 runs):

- stance rendering + skill-graph fixpoint (`renderStance`, resolve*)
- tool compilation (`compileTool`/doors/intrinsics) + wire modes
- the model step (streaming, part consolidation, retry)
- turn evaluation semantics (init forms, TickEvent, retry/Refused)
- the message-shape helpers (`asUserMessage`, note framing, coda)

Likely substrate SEAMS (the swappable bits):

- `RunStore` — inbox/thread/children/reminders/seq persistence
- `RunClock` — remind scheduling (fiber vs alarm)
- `RunTransport` — actor verbs ↔ run engine (in-process call vs RPC)
- `RunConcurrency` — loop fiber vs burst-per-event
