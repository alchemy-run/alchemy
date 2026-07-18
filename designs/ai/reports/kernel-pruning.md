# Kernel pruning — the minimal AI core

Status: ADOPTED + IMPLEMENTED (2026-07-17). Prompted by: "what are the
absolute minimal pieces we need for representing the AI.Kernel, leaving
the rest to user space like services/alchemy-org/src/issues.ts?"

Implemented: `EventChannelService`/`GitHubEvents`/`GitHubEventsLive`/
`GitHubSourceProps`/`resolveSourceRepo` deleted; `EventSource` slimmed
to `{ name, schema, owner, description?, key? }` (one type parameter);
`Services.ts` — event refs contribute nothing to `Req`;
`KernelMemory` split into `memoryCore` and `AI.memory` (the reference
ASSEMBLY: core + `AskHubMemory` + `EventBusMemory` +
`TraceStoreMemory`, named explicitly); services/alchemy-org dropped
its vestigial `EventBusLive` lines; agent-chat-web keeps its bus (the
same-harness case).

Follow-on rulings (owner, same day):

- **`AI.EventSource` → `AI.Event`.** Nothing is sourced from it — the
  name was the auto-delivery era's fossil. It is the event-storming
  sticky note: a pure message declaration (`isEvent`, `EventOwner`,
  `EventOptions`; `EventSource.ts` → `Event.ts`).
- **`AI.exit(AI.when(source))` is DELETED** — combinator abuse: it put
  exit correlation (a delivery concern) into the charter. The
  component owns run endings; the kernel just runs the loop. A charter
  with NO halt is *externally settled*: work round → park → steer
  wakes another round — until the implementation Layer calls
  `settle(key, event)`. Correlation IS the admission key (no kernel
  subscriptions, no `match` callbacks, no key-equality machinery);
  `Out = unknown`; the ending is ordinary prose. With that, the kernel
  subscribes to NOTHING — the EventBus component's one kernel job is
  `ctx.emit` fan-out.

Two refinements that emerged during implementation (owner):

1. **No `serviceOption` either.** Optional polling is a soft default
   in disguise — "absent" becomes an implicit configuration the core
   silently interprets. `memoryCore`'s components are ordinary
   REQUIREMENTS (`R = LanguageModel | TraceStore | AskHub | EventBus`),
   and absence is a NAMED implementation: `EventBusNone` (publications
   drop; subscriptions never deliver; exits settle only explicitly)
   and `AskHubNone` (the first ask dies with an assembly error). Every
   kernel's component list is fully explicit in its Layer graph.
2. With the channel gone, the bus is the assembly's ONE same-harness
   injection surface for exits — the owner gate stays on `ctx.emit` (a
   process cannot publish a world-owned source), but a harness/test
   MAY publish world events to the bus (it IS the world).

## The audit

What each event-system concept actually carries today, measured against
the resting model (implementations own delivery; exit delivery is
delivery; interface-bearing tags are sealed):

| concept | real load today | verdict |
|---|---|---|
| `AI.EventSource` — name, schema, owner, description, key | THE prose vocabulary: types `AI.when`/`AI.exit` (`In`/`Out`), renders combinator clauses, gates affordances by owner, correlates by key. Used by the GitHub catalog, org-internal events, every charter. | **keep, slimmed** |
| `AI.EventSource` — `Channel` phantom, `channel` field, `props` | Tells a channel Layer what to provision/filter. Its ONLY family is `GitHubEvents`; its only Layer is `GitHubEventsLive` — a Phase-2 stub returning `Stream.never`. The kernel already never subscribes channel-backed sources. | **delete** |
| `AI.EventChannelService` | The contract only that stub implements. | **delete** |
| `GitHubEvents` tag + `GitHubEventsLive` | A compile fence forcing a dead stub into worker graphs. The REAL fence exists in user space: `GitHubIssuesLive` requires `GitHub.RepositoryEventSource` — forget the webhook/polling Layer and the deploy fails to type-check through the seam. | **delete** |
| `AI.EventBus` (public service) | Two jobs: deliver machine exits on ORG-INTERNAL sources between same-kernel rings, and fan out `ctx.emit`. NOT part of the kernel contract — it is a component ONE implementation (KernelMemory) uses, though that implementation blurs the line by fabricating a memory bus via `serviceOption` when none is assembled. In services/alchemy-org it is provided and nobody subscribes. | **keep as an optional component; fix the reference impl's silent default** |

Delivery itself is already user space and stays there — `issues.ts` is
the reference: `consumeRepositoryEvents` (typed wire) → `Match.tag` →
`ledger.offer` → `send`/`steer`/`settle` against the sealed inner
service.

### Why EventBus existed (and why its reasons are gone)

The bus was built for three jobs, all from the AUTO-DELIVERY era:
(1) the in-memory symmetric twin of `EventChannelService` — two
channels, one kernel that subscribes to both; (2) the DDD event fabric
— process A emits a Fact, process B's policy reacts (never
materialized: the factory publishes `IssueParked` into a bus nobody
subscribes to, and cross-kernel reaction can't ride a memory bus
anyway); (3) test injection/observation (superseded by
`send`/`steer`/`settle` and `kernel.events`). Each delivery ruling
("delivery is always code", "exit delivery is delivery") stripped a
subscription the bus served; it survived because KernelMemory
fabricates it silently, so its weight never showed in any assembly.

The resting insight (owner): **emission is an action.** The kernel's
irreducible part is what the term language demands — the publish-grant
check (`${Event}` mention, owner gate) and the durable Trace row. The
fan-out half of today's `ctx.emit` (the `eventBus.publish` bolted after
the row) is routing physics, suppliable by a Layer like any tool's —
where the announcement goes is the assembly's business, not the
contract's.

## The proposal

### 1. `AI.EventSource` becomes a pure message declaration

```ts
interface EventSource<In> {
  name: string;
  schema: S.Top & { Type: In };   // types AI.when / AI.exit
  owner: "org" | "world";         // affordance gate (canon §2a r4)
  description?: string;           // the combinator clause
  key?: (payload: In) => string | undefined;  // correlation
}
```

Deleted: the `Channel` type parameter, the `channel` field, `props`,
`EventChannelService`, and the channel-bearing constructor overloads.
An EventSource declares vocabulary, typing, affordance, and identity —
it never carries provisioning config and nothing ever subscribes to it
through the kernel. The GitHub catalog constructors keep the repo
argument only to derive `name`/`description`/`key` (via the static
identity of the `Repository` resource); `GitHubSourceProps` and
`resolveSourceRepo` die with the channel.

`Services.ts` simplifies: event refs contribute NOTHING to `Req` (the
last contributor was the org-internal channel-backed publish grant —
there are no channel-backed sources left). Bare-mention publish grants
remain a topology/`ctx.emit`-permission fact, not a requirement fact.

### 2. Minimize the CONTRACT; free the implementations

The design goal (owner, 2026-07-17): the kernel core is minimally
opinionated; capability comes from Layer assembly, where each layer may
bring its own dependencies without imposing them on every kernel.

The precision that matters (owner correction): `KernelMemory` is ONE
implementation behind the `AI.Kernel` tag — nothing it does affects
other kernels. What affects EVERY kernel is the **contract**: the
`KernelService` interface, the term language (`EventSource`, the
signature expressions), and the interpretation semantics those imply.
An implementation must honor whatever the contract promises about
`ctx.emit` and machine exits — so anything the contract says about a
"bus" conscripts every implementation into building one. THAT is where
the pruning must happen:

- **Contract-level (binds every kernel — keep minimal).**
  `ctx.emit(X, payload)` = one durable Trace row + a `message.emitted`
  kernel event. Machine exits settle by explicit delivery —
  `settle(key, event)` — uniformly, org-internal and world-owned alike
  ("exit delivery is delivery", now with no carve-out). The contract
  says NOTHING about a bus; `EventSource` (slimmed, §1) is pure
  vocabulary the contract types `when`/`exit` with.
- **Implementation-level (each kernel's own choice).** Auto-settling
  same-kernel org-internal exits when another ring emits the source is
  a FEATURE an implementation may offer, built however it likes:
  KernelMemory composes `AI.EventBus`; a DO kernel might route through
  its own storage; a minimal kernel offers nothing and delivery stays
  explicit. `AI.EventBus` remains a public seam so assemblies that
  want ONE bus shared between the kernel and harness code
  (agent-chat-web's server) can provide the same instance to both —
  but no contract text requires its existence.
- **The reference implementation stops blurring the line.**
  KernelMemory today fabricates a memory bus (and ask hub) via
  `Effect.serviceOption` when none is assembled — making the optional
  component LOOK like contract behavior. Fix: the components are true
  options; `AI.memory` (the reference ASSEMBLY) provides them
  explicitly, so tests and laptops keep their one-liner while the
  Layer graph tells the truth about what this kernel has.
- **Absence is honest, not silent**: with no bus in the assembly, a
  charter whose machine exit names an org-internal source is
  satisfiable only by explicit `settle`. `AI.lint` (or interpret-time
  diagnostics) can note it; no implementation papers over it by
  conjuring a bus.

Same treatment applies to `AskHub` (same fabricated-default pattern in
KernelMemory) and to every future component (compaction, codemode
executor, memory): components are Layers an assembly names, never
defaults an implementation invents — and never contract text.

Migrations under this shape:

- `KernelMemory`: remove the fabricated defaults; take bus/ask-hub as
  true options wired by the `AI.memory` assembly.
- `services/alchemy-org` local.ts/worker.ts: drop `EventBusLive` from
  their assemblies (nothing subscribes — the factory's exits are all
  world-owned and settle through the drive loops).
- `agent-chat-web` keeps its bus — it IS the same-harness case the
  component exists for (though `closeIssue`'s `bus.publish` to end a
  run reads more honestly as `settle`).
- Cross-kernel org events (DO-sharded rings) were never going to ride a
  memory bus; that wiring is user-space delivery like everything else.

### 3. The minimal kernel surface

**Terms** (declarations): `Process` (sealed interface semantics),
`Agent`, `Tool`, `Parameter`, `EventSource` (slimmed).

**Signature expressions**: `when`, `exit`, `until`, `never` (+ the
judged/compressed variants `check`, `fold`, `concurrency`, `observe` —
kept, they are refs the kernel interprets, not services).

**The kernel core**: `Kernel` (`interpret`, `process`, `events`,
`trace`), `ProcessService` (the actor verbs — the
kernel↔implementation contract), `ProcessContext` (`ctx.emit` = Trace
row, always), `TraceStore`, `Errors`.

**Kernel components** (Layers an assembly names; no silent defaults):
the model, `Budget`, `AskHub` (approvals and subagent waits), and
`EventBus` (same-harness org-event delivery). `AI.memory` is the
reference assembly of the memory components.

**Introspection**: `Render`, `Topology`, `Lint` — pure functions over
terms; cheap to keep, used by tests and the UI.

**Everything else is user space**, and `issues.ts` is the shape: wires
(`consumeRepositoryEvents`), dedupe (`Ledger`), routing (`Match`),
domain interfaces (sealed tags), credentials, budgets-at-composition.

### 4. Second-tier audit (separate pass, not this change)

Candidates spotted while surveying, each with thin usage: `Pairing`
(2 uses), `Value` dynamic prose (1 use), `Step`/`Api` namespaces,
`KernelPrompts` (kernel-internal — should at minimum stop being
exported from the barrel). Decide after the event-system prune lands.

## Order of work

1. Delete `EventsLive.ts`, the `GitHubEvents` tag, `GitHubSourceProps`,
   `resolveSourceRepo`; re-derive catalog constructor names/descriptions
   from the repo argument directly.
2. Slim `EventSource.ts` (drop Channel/channel/props + overloads);
   simplify `Services.ts` event-ref rules; fix `Org.types` Req audits.
3. No-silent-defaults: `KernelMemory` takes `EventBus`/`AskHub` as true
   options; `AI.memory` becomes the explicit reference assembly that
   composes the memory components; org-exit delivery without a bus is
   explicit `settle` (lint/diagnostic when a charter needs one and the
   assembly has none).
4. Sweep assemblies: drop `EventBusLive` from services/alchemy-org
   (vestigial); keep it in agent-chat-web (the same-harness case);
   update the canon (§2 concept table + a "kernel assembly" ruling) and
   index.
