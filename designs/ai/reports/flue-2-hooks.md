# Flue 2.0 Agent Hooks — what it is, how it maps, what to take

Sources: the Flue 2.0 release post and the Agent Hooks API reference
(flueframework.com/docs/reference/agent-hooks-api), plus the vendored
1.0-era codebase at `.vendor/flue` (the hooks rewrite postdates the
vendor snapshot; the runtime's durability machinery — conversation
records, submissions, compaction, the pi harness seam — is unchanged
underneath). Verdict up front: **Flue independently re-derived our
level-triggered turn, then expressed it in an imperative dialect.**
The framework-shaped ideas are ones we already hold declaratively;
two capabilities are genuinely worth ratifying, and both fit an
"optional kernel capability" tier the spec already hints at — no new
kernel surface required by all kernels.

## 1. What Flue 2.0 actually is

An agent is a **function, re-run ("rendered") before every model
call**. Hooks are calls made during the render that record onto an
ambient frame:

```ts
export function SupportAgent() {
  useModel('anthropic/claude-haiku-4-5');
  const [escalated, setEscalated] = usePersistentState('escalated', false);
  useTool({ name: 'escalate', run: () => setEscalated(true) });
  if (escalated) useTool(refundTool);       // conditional capability
  return 'Answer support questions accurately.';   // the instructions
}
```

Sixteen built-ins in four families:

- **Resources** — `useModel` (required, once), `useSandbox`,
  `useTool`, `useSkill`, `useSubagent`, `useMcpConnection`,
  `useInstruction`. Conditional and reorderable (set changes are
  *narrated to the model* as `resources` signals, preserving the
  prompt-cache prefix); duplicates throw.
- **State & input** — `usePersistentState` (durable JSON KV keyed by
  name, render-snapshot reads, setter writes committed atomically
  with the tool batch that made them), `useInitialData` (creation
  constant), `useDelivery` (the message before the model, as a
  cursor).
- **Lifecycle seams** — `useAgentStart` (per delivered message,
  async, the intake seam), `useAgentFinish` (at every would-stop
  point; may `append` a signal to push the model back within the same
  response, capped at a fixed 32 continuation cycles),
  `useResponseStart`/`useResponseFinish` (sync metadata stamps).
- **Client channel** — `useDataWriter` (named one-way data parts
  streamed to the UI; identity-invariant across renders).

The rules of hooks are runtime-enforced: hooks throw outside a
render; setters throw during a render (renders are pure reads);
`useModel` exactly once; data-writer names structurally identical
every render. Value scoping is tiered: model/sandbox/MCP configs are
*submission*-scoped, resource sets and instructions are *per-render*,
sandbox *presence* is per-turn-boundary. Subagent renders get a
restricted frame (no model, no state, no lifecycle hooks).

## 2. The convergence — and the dialect difference

Flue's foundational move is our §1 verbatim: *the configuration is
re-derived before every sampling; the render is the agent.* Their
blog's own framing ("static agent definitions break down; recompute
capabilities each turn") is the level-triggered doctrine.

The difference is dialect. Flue hooks are **imperative registration
against an ambient mutable frame** — which is why they need
runtime-enforced rules (call order, no-calls-outside-render,
identity invariance). Our stance is a **returned value**: prose with
spliced refs, where mention *is* presence (§2b). Every Flue example
translates to a splice:

```ts
// Flue                                  // alchemy
if (escalated) useTool(refundTool);      ${(yield* Ref.get(escalated)) ? refund : ""}
useModel(hard ? 'fable' : 'kimi');       stance.pipe(AI.model(hard ? "default" : "fast"))
useInstruction(text);                    AI.prose`${text}`
function useLinear(key) {...}            a Layer providing tools + a Fragment helper
```

The "rules of hooks" disappear in our dialect because there is no
ambient frame to corrupt: composition is function/Effect composition,
and *when* something may be called is carried by the **R channel** —
a capability that only makes sense mid-turn requires `AI.Tick`; one
that needs the run requires `AI.Thread`; calling it in the wrong seam
is a compile error, not `[flue] useTool() was called outside an agent
function`. **Our hooks are `yield*`s, and the rules of hooks are the
type system.**

One Flue mechanism worth respecting: they *narrate* resource-set
changes to the model as signals to keep the serialized prompt prefix
cache-stable. We instead redeliver the whole system prompt and make
byte-stability the author's choice (§11). Both are coherent
cache-discipline positions; ours is simpler and keeps the kernel out
of the copywriting business (narration is kernel-authored prose — the
same smell as our `<note>` markers, at larger scale).

## 3. Hook-by-hook mapping

| Flue | alchemy today | gap? |
|---|---|---|
| render-per-model-call | the TURN (§1) | none — identical |
| `useModel` + thinking level | `AI.model(...)` Fragment annotation + `Models` service (§12) | §12 is designed, not yet implemented |
| `useTool` conditional | mention-is-presence splices (§2b) | none |
| `useSkill` (catalog line + `activate_skill` + briefing-as-tool-result) | `AI.Skill` + `skill` intrinsic — same design to the letter | none |
| `useSubagent` (static `task` tool spec for cache) | `${Agent}` mention → `dispatch` intrinsic; doors for policy (§9) | none; doors are stronger (policy in code, session invariants by absence) |
| `useInstruction` | `AI.prose` composition | none |
| `usePersistentState` | `Ref` (ephemeral by doctrine, §3) + "derive from the world" | **real gap on durable kernels** — §3 already promises the opt-in named-state variant |
| `useInitialData` / `useDelivery` | the run key + admission event; `tick.inputs` | none |
| `useDispatchMessage` | actor verbs / `Thread.remind` | none |
| `useAgentStart` (async intake) | the turn itself is async; observation-as-a-fetch with `cachedWithTTL` (§5) | none |
| `useAgentFinish` (would-stop enforcement, append-to-continue, ceiling 32) | quiescence parks (§11); budgets/goals are patterns (§6); `AI.reply` is the explicit completion | **deliberate non-feature** — see §5 below |
| `useResponseStart/Finish` metadata | observations + structural metadata (`kind`, `at`) read by projections | none — ours is observer-side, not charter-side |
| `useDataWriter` | observations → Chats → UI projections | userland-able; no kernel change |
| `useMcpConnection` | nothing | ecosystem library: a Layer that connects and yields `AI.Tool` impls — mention-is-presence handles the rest; zero kernel surface |
| `CompactionConfig` on `useModel` (built-in threshold compaction, `false` to disable) | §7 kernel mechanism / userland policy, always present on `Thread` | see §4 — argues for making the *capability itself* optional |
| custom hooks | plain functions / Layers / Effect helpers | none — and no `use` naming convention needed |

## 4. The design questions, answered

**Can an assembled kernel define its own hooks?** Yes — and we
already have the mechanism: an assembled kernel is a Layer, and a
"hook" is a *service the kernel provides into the charter's context*.
A kernel extension is just an extra service in that context; charter
code that yields it declares the dependency in its R channel. There
is no registration API to design — `Context.Service` + Layer
provision *is* the extension system, and misuse is a type error at
composition time rather than a runtime throw.

**How does user code stay kernel-agnostic?** By what its R names.
This suggests formalizing the kernel contract as two tiers:

- **Tier 0 — intrinsics** (every kernel must provide): `AI.Thread`
  (key, entries, tokens, reply), `AI.Tick` (count, say), dispatch/
  doors, and the loop semantics of §1/§11. A charter whose
  requirements stay within tier 0 runs on any kernel, provably.
- **Tier 1 — optional capabilities** (a kernel MAY provide, each its
  own service): the clock (`remind`), thread surgery (`compact`),
  durable named state. A charter that uses one carries it in R;
  composing it with a kernel that lacks it fails at `Layer.provide`,
  at compile time. Portability stops being a convention and becomes
  a visible type.

**Should compaction be required of all kernels?** No — and this
restructuring gets there without losing §7's guarantees. Split
`compact` (and `remind`) off the monolithic `Thread` interface into
their own tier-1 services (`AI.Compaction`, `AI.Clock` — names TBD).
§7's doctrine is unchanged *for kernels that provide it*: mechanism
(boundary application, recorded, archived markers) stays kernel;
policy stays userland. A minimal assembled kernel simply doesn't
provide the service, and no charter that type-checks against it can
demand it. Note Flue landed on the opposite default — threshold
compaction always on, opt-out via `compaction: false` — because their
policy lives in the runtime. Ours lives in userland, so we don't need
a default at all.

## 5. What to adopt, what to decline

**Adopt: durable named state as a tier-1 capability.** This is
Flue's flagship demo (workflow steps, earned tools, model trade-up)
and our one real gap: on KernelCloudflare the charter closure is
isolate state — a `Ref` dies with the DO eviction, and "derive from
the thread" is the wrong tool for a three-step state machine. §3
already promises exactly this ("the durable kernel's opt-in
named-state variant. Don't tax every charter with naming").

**Implemented as `alchemy/PersistentRef`** — deliberately NOT an
`AI.*` concept: a durable Ref is useful in any Worker, Durable
Object, or server, and the persistence surface is a swappable Layer
(`PersistentRef.Store`), which also makes it a natural binding
target. See the sidebar below for the design.

```ts
const phase = yield* PersistentRef.make("phase", () => "reproduce");
// four deliberate ops: get / set / update / modify — writes settle
// when the store's write settles; requires PersistentRef.Store in R
```

Both kernels provide the `Store` in run scope: KernelMemory a
per-run Map (durability = the substrate's lifetime), KernelCloudflare
the DO's synchronous SQLite-backed KV under an `alchemy:ref:` prefix.
Names are identity (memoized per store instance — no diverging caches
of one row); defaults are never persisted; schema-encoded values
round-trip; a decode failure on load is a loud defect.

### Sidebar: Rivet's "persistent Ref" and why the constructor is the seam

Rivet's Effect SDK for Actors markets "your `Ref`, now stateful" —
but it does **not** make `Ref` persistent. Their `State` module
*mimics* the Ref API (`get`/`set`/`update`/`updateAndGet`/`changes`)
while being a separate concept: one schema-typed value per actor,
declared on the layer definition (`state: { schema, initialValue }`),
handed to the wake function as an argument — and every operation has
an error channel (their own examples pipe every `State.*` call
through `Effect.orDie`). A real `Ref` is infallible; theirs isn't.

Bare `Ref.make` can't be transparently durable for three reasons:

1. **Anonymous identity.** Refs are created positionally in a
   closure; after passivation the init re-runs and creates *new*
   refs. Matching them to persisted rows needs a stable key — a name,
   or call order. Call order is the React-hooks disease. This is why
   Flue names state and Rivet hoists one schema'd blob to the
   definition: durable identity requires explicit naming, and
   `Ref.make` has nowhere to hang one.
2. **Unconstrained `A`.** A Ref can hold a Map, a closure, a tool
   handle; durability silently imposes serializability — a type lie.
3. **The infallible signature.** Persistence adds failure and
   latency; Rivet paid with an error channel and orDie litter.

We split the difference deliberately. An early cut implemented the
literal `effect/Ref` interface (in Effect 4 every combinator funnels
through `ref.current`, so an accessor property is a workable
persistence seam) — rejected: it couples to Ref's internal
representation, and because Ref's ops are `Effect.sync` there is no
seam to *await* a store, which forces sync-only stores. Instead
`PersistentRef<A>` is our own **four-method interface** — `get` /
`set` / `update` / `modify` — few enough ops to own honestly:

- Reads are always memory (no round trip). A write updates memory
  immediately and **settles when the store's write settles** — the
  durability point is in the caller's hands, and async stores (KV,
  D1, filesystem) are first-class, not a `runSync` landmine.
- Writes per ref are serialized FIFO through a semaphore, so a slow
  older write can never clobber a newer one.
- Failures stay **defects** (crash-and-retry, at-least-once), not a
  `StoreError` threaded through charter code — the orDie litter is
  Rivet's tax, not ours.
- Refs are memoized per (store, name): no diverging in-memory caches
  of one durable row; a fresh activation (new store instance)
  re-loads from storage.

The `Store` contract (`load` + `write`, both Effects) is deliberately
minimal rather than Effect's `unstable/persistence` `KeyValueStore`;
adapters over `KeyValueStore` — and a buffered-flush variant giving
burst-atomic writes (flush at burst commit, so an abandoned burst
never half-writes) — can layer on later without changing consumers.
Rivet's `State.changes` reactivity maps to our observations and is
not needed for v1.

Landed: `packages/alchemy/src/PersistentRef.ts` (module + memory
store), `src/Cloudflare/Workers/PersistentRefStore.ts` (DO store over
the synchronous SQLite-backed KV — output gates make durability
automatic), both kernels provide `PersistentRef.Store` in run scope,
and `test/PersistentRef.test.ts` pins the contract (op semantics,
resume-on-reactivation, per-store memoization, async-store write
ordering, schema round-trip).

**Decline (keep as pattern): the finish/enforcement seam.**
`useAgentFinish` is Flue's most novel hook — inspect the response at
its would-stop point and push the model back. We deliberately lack
it: quiescence parks, and §6 makes exit/goals *patterns* (`AI.reply`
as achieve, `Refused` as refuse, prose + budget guards otherwise).
Flue's own design shows the hazard: it needs a hardcoded
32-continuation ceiling to stop hook-authored infinite loops. Our
equivalents cover the real cases — a worker that must not stop early
is a door whose task says so plus a guard that refuses at budget; a
supervisor that checks completeness does it at the next wake (the
world's clock, not the model's). If evidence accumulates that
next-wake is too late in practice, revisit as a §13 deferred item
("quiescence guard: a turn-shaped function of the would-park state")
— but not now.

**Decline (userland): MCP mounting, data writers, metadata seams.**
All three are Layers/projections in our model. MCP specifically: a
community `Cloudflare/MCP`-style package exporting
`McpTools(url, opts): Layer<...>` that yields dynamically-built
`AI.Tool`s — mention-is-presence and the toolkit compiler already
handle the rest. No kernel changes.

**Already held, no action:** conditional capability (splices),
per-tick model tiers (§12 — Flue validates the design; note theirs is
only *submission*-scoped, ours is genuinely per-tick), skills'
progressive disclosure (identical mechanism), subagent isolation and
the static-dispatch-spec cache insight, async intake (the turn),
custom hooks (functions).

## 6. What we have that Flue doesn't

Worth recording, since "React for Agents" will pull mindshare:
typed errors and typed capability requirements (their rules of hooks
are our compiler); physics as Layers (their sandbox/channel adapters
are our provide-lists, but ours swap per environment without touching
the charter); doors — delegation with the session invariant enforced
by *absence* of a parameter; world events as first-class typed
vocabulary rather than `kind: 'signal'` strings; one kernel contract
over two substrates with parity tests; the observation log as the
canonical record with projections at the edge (their conversation
records are equivalent machinery, but client-shaped).

## 7. Recommended actions

1. Spec: add the **kernel contract tiers** (intrinsics vs optional
   capabilities) — probably a short §1b — and move `compact`/`remind`
   language to note they are tier-1 services a kernel MAY provide.
2. Spec §3: upgrade the named-state sentence to point at
   `alchemy/PersistentRef` (tier-1 via the `PersistentRef.Store`
   service in R). DONE in code; spec edit pending.
3. ~~Implement durable named state in both kernels~~ DONE —
   `PersistentRef.make` + memory/DO stores, provided by both kernels;
   burst-atomic buffered store is the noted follow-up.
4. §13 deferred: note the declined finish-seam with the reasoning,
   and MCP-as-Layer as ecosystem work.
5. No hooks API. The R channel is the hooks API.
