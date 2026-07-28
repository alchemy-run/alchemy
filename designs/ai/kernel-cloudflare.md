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

## v1 simplifications (accepted, revisit in layering)

1. **Held-open dispatch RPC** — parent and child pinned for the round;
   an eviction mid-round fails the round (the caller sees the error;
   world re-delivery re-drives it). Durable continuations are v2.
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
