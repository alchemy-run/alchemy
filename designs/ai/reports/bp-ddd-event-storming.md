# Business processes as code — DDD / Event Storming, embedded not implemented

Status: **v4.1** (July 2026), incorporating the canon's §2a signature
reduction (`AI.on` → `AI.when`; `AI.emit` subsumed by the unmarked
event mention, which IS the publish grant; `AI.each`/`AI.every`
deleted outright; `Trigger.ts`/`Emit.ts`/`Halt.ts` consolidate into
`Signature.ts`). This revision supersedes v2 and v3 — in
particular v3's centerpiece design chapters (the "keyed, stateful
Process" with `AI.command` / `AI.key` / `AI.state` splices and staged
transactional state commits), which are now **rejected design**. The
single source of truth for the resting model is
[designs/ai/business-processes.md](../business-processes.md) (the canon);
where anything in this file appears to disagree with the canon, the
canon wins.

What this file is now, in three parts:

1. **The durable research** (§1–§3): the DDD / Event Storming concept
   survey, the concept-by-concept mapping table, and the prior-art
   notes — compressed from v1–v3 but substantively unchanged, because
   the research held up even as the design moved.
2. **The history** (§4): what was proposed in v1/v2/v3 (`AI.command`,
   `AI.key`, `AI.state`, keyed ring families, `AI.Entity`, staged
   commits, refusal-as-fact from inside a process), what the owner's
   objection was at each round, and why each was rejected. This mirrors
   the canon's removed-concepts ledger, with the reasoning preserved so
   none of it is ever relitigated.
3. **The embedded patterns** (§5) and **the worked example** (§6): how
   every DDD concept is expressed *in userland* over the resting
   primitives, with code sketches — the chapter the docs' future
   "model a business process" tutorial grows from.

Method (unchanged from v3, noted for provenance): `src/AI/{Process,
Agent,EventSource,Trigger,Halt,Kernel,ProcessContext,TraceStore,
EventBus,Topology}.ts`; `src/AI/KernelMemory.ts` (spot-read);
`examples/agent-chat-web/src/{org,server}.ts`;
`src/GitHub/RepositoryEventSource.ts`; the sibling reports
(`bp-dx-open-source-org.md`, `bp-kernel-layers-codemode-skills.md`,
`agent-loop-algebra.md`, `perpetual-vs-goal.md`,
`reassess-exit-conditions.md`); web research on Event Storming
(Brandolini), Event Modeling (Dymitruk), the decider pattern
(Chassaing), Emmett, Wolverine/Marten, Axon, Restate, Temporal, and the
2024–2026 DDD-for-agents literature. `file:line` citations reflect the
source as of the research rounds; web-sourced claims are marked.

---

## 0. Verdict up front (v4)

**Adopt the vocabulary and the workshop-to-code grammar; build no DDD
construct of any kind.** The resting model is smaller than every
proposal this report cycled through, and it is sufficient:

- **Two worlds, one seam.** The *deterministic world* (plain Effect
  code + Alchemy infrastructure) owns APIs, validation, **denial**,
  routing, your database and its transactions, cron, projections, and
  read models. The *reactive world* is Processes: **actors whose
  behavior can be written in prose** (or model-written codemode, or
  plain Effect code — a Layer choice behind one `Context.Tag`).
- **Everything is a message.** An *instruction* is an addressed message
  — a plain schema, no construct. An *event* is a broadcast message —
  `EventSource` is a named broadcast channel. The framework never
  distinguishes them; the message's name and tense carry the meaning,
  and the actor's prose interprets it.
- **Delivery is always explicit code.** `send`/`dispatch` create an
  actor (a run is created by its first message); `steer(runKey, msg)`
  addresses a running actor. Nothing auto-delivers: `AI.when(X)` is a
  pure *input declaration* (types `In`, renders in prose, appears in
  topology) with no subscription runtime behind it. The front door —
  a webhook consumer, an HTTP route, platform cron — validates, denies,
  adapts, and picks the door.
- **Output is typed emission.** `ctx.emit(EventSource, payload)` writes
  one durable Trace row AND publishes on the typed channel; the
  unmarked `${X}` event mention (legal anywhere in the
  template, including nested inside judgment prose) IS the publish
  grant — it declares "I may publish X" and permits `ctx.emit`. A
  truly inert mention is plain text or `${X.name}`.
- **Exits are unchanged** from the pre-DDD design: `AI.until(schema)`
  (model-declared, graded), `AI.until(source, match)` (machine-observed
  with per-item `match` correlation), `AI.never` (perpetual).
- **State is not a framework concept.** If you have a database:
  validate + write + emit in *your* transaction, outside the process.
  If you don't: the Trace is the record, and state is a **userland
  fold** over the facts a long-lived run emitted (the `deriveState`
  convention; snapshots are caches keyed by `seq`, rebuildable, never
  authority). Event sourcing is embedded as a documented pattern, never
  implemented as a construct.

Everything DDD-shaped — Command, Aggregate, Policy, Saga, Bounded
Context, CQRS read models — is then a **documented pattern over those
primitives** (§5), and the Event Storming board compiles to primitives
+ patterns with `tsc` as the completeness check (§7). The pitch that
survives every round: *an actor system where the behavior can be
written in prose* — and the DDD workshop grammar embeds into it without
the framework ever learning a DDD word.

Three findings from v1–v3 that remain true and load-bearing:

1. **The system already is CQRS + event sourcing — internally.** The
   Trace is an append-only, per-ring sequence-numbered event log
   (`TraceStore.ts:33-50`); serving transcripts and timelines are
   materialized views of it ("rows are truth, wakes are hints",
   `Kernel.ts:71-76`); `dispatch`/`send` are a typed, durable,
   idempotent admission protocol (`Process.ts:50-61`). The correct move
   was always to **name** what exists in ES/DDD vocabulary, not to
   re-platform the user surface onto CQRS machinery.
2. **Typed emission was the single highest-leverage small change** —
   proposed in v1 (§3.1 then), endorsed in every review round, and the
   one piece of new surface the resting model kept (plus the event
   mention that declares it in prose — formerly an `AI.emit` ref, now
   the unmarked-grant rule).
3. **One deep conflict is resolved by doctrine, not adoption**: event
   sourcing says *the log is truth*; the reconciler doctrine says *the
   world is*. The two-species split (world-owned vs org-owned state,
   §3.4) survives every revision: folded state about entities the world
   owns is a belief/cache, never authority; exits are machine-observed
   wherever the world owns the state.

---

## 1. The research digest

*(Kept from v1 essentially unchanged — this is the durable half of the
report. Compressed where the original was verbose.)*

### 1.1 Event Storming (Brandolini) — the notation, verified

Web-sourced (bmf-tech.com, archi-lab.io, raysinnema.blog,
amanagrawal.blog; consistent across all four):

| Sticky | Color | Meaning |
|---|---|---|
| **Domain Event** | orange | a fact that happened, past tense ("Order Placed") |
| **Command** | blue | the action/decision that triggers an event ("Place Order") |
| **Actor** | small yellow | the person who issues a command |
| **Aggregate** | large yellow | the cluster that accepts commands and emits events, guarding invariants |
| **Policy** | lilac/purple | a reactive rule: "**whenever** X **then** Y" |
| **Read Model** | green | the information consulted to make a decision |
| **External System** | pink | a third party interacting with the process |
| **Hot Spot** | red | an unresolved question, conflict, or risk |

The grammar is causal and cyclic: *Actor → Command → Aggregate → Event
→ (Policy → Command …) | (Read Model → Actor …)*. Three workshop
levels: **Big Picture** (events + hot spots only), **Process Level**
(add commands, policies, read models, external systems), **Design
Level** (add aggregates — where DDD tactical design begins).

Two properties matter for us: (1) the notation is a *bridging
vocabulary* — domain experts place orange stickies without knowing
software; (2) the grammar is *checkable* — "what command leads to this
event, and who issues it?" is a mechanical completeness question. Both
are exactly what an NL→code-generating agent needs (§7).

### 1.2 Event Modeling (Dymitruk) — the prescriptive sibling

Web-sourced (eventmodeling.org, axoniq.io blog). Event Modeling is
Event Storming made blueprint-grade: a timeline with swimlanes and
exactly four building blocks (Trigger, Command, Event, Read Model) in
exactly four patterns:

| EM pattern | Shape | The alchemy analogue (v4) |
|---|---|---|
| **State Change** | Command → Event(s), Given/When/Then | API route / front door: validate → deny → write your DB → emit → deliver (§5.1) |
| **State View** | Event(s) → Read Model | a projection consumer over emitted facts / the Trace — plain code (§5.5) |
| **Translation** | foreign Event → local Command | the front door's adapter: transport payload → domain message (§6.2) — Axon's blog explicitly calls this "an Anti-Corruption Layer" |
| **Automation** | Read Model (todo-list) + Processor → Command | deterministic code sends to a Process; cron → `send` (§5.3) |

Dymitruk's core claim: a model built this way "can be checked for
completeness by following the single thread of data propagation through
it." In alchemy that check is not a facilitator's eyeball — it is `Req`
derivation and Layer composition failing to compile
(`EventSource.ts:49-54`). This remains the strongest single argument
that the vocabulary *fits*: Event Modeling's manual completeness check
is alchemy's type system.

Note how well the resting model matches Event Modeling's own shape:
EM's *Automation* pattern — deterministic processor reads a todo list
and issues commands — **is** the front-door doctrine ("delivery is
always code"). The owner's "deterministic code always in front of
processes" was Event Modeling's Automation pattern all along.

### 1.3 DDD — strategic and tactical, and where CQRS/ES sit

Strategic DDD (the part that ages well): **Bounded Context**,
**Ubiquitous Language**, **Context Mapping**, **Anti-Corruption
Layer**, **Published Language**.

Tactical DDD (the part that gets cargo-culted): **Aggregate**
(consistency boundary; one transactional stream; referenced by id),
**Entity** / **Value Object**, **Domain Event**, **Repository**,
**Domain Service**, **Saga / Process Manager** (starts on an event,
correlates by association id, issues commands, and — per the Axon docs
— **must end**).

CQRS and Event Sourcing are orthogonal add-ons, and the literature's
own warnings are unambiguous (web-sourced): Greg Young — "CQRS is not a
top-level architecture … The largest failure I see from people using
event sourcing is that they try to use it everywhere"; Fowler — "for
most systems CQRS adds risky complexity." Practitioner consensus
(multiple 2024–2026 retrospectives): apply within a bounded context
that has genuinely divergent read/write shapes or a genuine
audit/temporal requirement; never as a uniform architecture. §5.2 and
§8 apply this warning to us.

### 1.4 Prior art in code — how the concepts are spelled

- **The decider pattern (Chassaing)** — the functional distillation
  everything else converges on (web-sourced, thinkbeforecoding.com):

  ```
  decide  : (Command, State) → Event[]     -- ALL business logic; rejects here
  evolve  : (State, Event)   → State       -- pure fold; no rules, no effects
  initialState : State
  currentState = fold(evolve, initialState, pastEvents)
  ```

- **Emmett (Dudycz, TS)** spells it exactly that way: a
  `Decider<State, Command, Event>` record, a
  `CommandHandler(eventStore, toStreamId, decider)` that reads the
  stream, folds `evolve`, calls `decide`, appends. Given/When/Then
  testing via `DeciderSpecification`.
- **Wolverine/Marten (.NET)**: `[AggregateHandler]` makes a command
  handler a pure `(Command, AggregateState) → Event[]`; Marten's
  `SingleStreamProjection` is `evolve`; the maintainers align the
  recipe with Event Modeling's State Change / State View patterns.
- **Axon (JVM)**: the ceremonial spelling — `@AggregateIdentifier`,
  `@CommandHandler`, `@EventSourcingHandler`,
  `@StartSaga`/`@SagaEventHandler(associationProperty = "orderId")`,
  `@DeadlineHandler`. Two Axon facts matter here: sagas **start on an
  event, correlate by association property, and must end** — precisely
  our long-lived run keyed by world identity with a machine-observed
  exit and a budget (§5.6); and a 2026 practitioner retrospective
  (saasforge.cz) found most saga workloads decompose into "state rows +
  scheduled sweeps + a workflow engine" — the saga *term* is rarely
  worth reifying, which matches our zero-new-term-kinds resting point.
- **Restate**: Virtual Objects — single-writer, key-addressed durable
  entities whose handlers process one message at a time. This is our
  run identity + mailbox-serial admission with the world identity as
  the key — the *actor* reading the canon now makes primary. Notable:
  a Restate demo advertises "event sourcing and CQRS *without* event
  store, broker, saga framework" — durable execution absorbing the
  CQRS machinery, the same absorption our kernel performs.
- **Temporal**: the workflow function *is* the process manager;
  compensation is `try/catch` in code, not a policy DSL. Our
  equivalent: Effect combinators over `dispatch`/`send` are the
  workflow language; no step-graph DSL.
- **EventCatalog (Boyney)**: documentation generator whose information
  architecture is domains / services / commands / events / queries —
  evidence that "the catalog of a context's commands and events" is a
  real artifact teams maintain; our `AI.topology` is the same artifact
  derived from terms instead of written by hand.

### 1.5 DDD-for-agents (2024–2026) — the landscape, honestly

The field exists but is shallow (all web-sourced):

| Who | What | Depth |
|---|---|---|
| Nikita Golovko, "From Prompt Spaghetti to Bounded Contexts" (GitNation 2025/26) | bounded contexts for agent responsibilities; schemas as contracts; ACLs as "semantic firewalls" | patterns + anecdotes; no framework |
| DZone, "Designing Scalable Multi-Agent AI Systems" (2025) | Event Storming + DDD to identify agent boundaries | methodology essay |
| Equiwiz, "EventStorming for Agentic AI" (2025/26) | one agent = one bounded context; agents communicate via domain events through ACLs | consulting playbook |
| "Steward Agents — Agentic DDD" (bennyjohns.com, Feb 2026) | one long-lived agent *owns* each bounded context | essay |
| Russ Miles / Rod Johnson, DDD + DICE | domain objects as first-class units of LLM context | essay + framework backing |
| **Embabel** (Rod Johnson, JVM, 2025) | the only *framework*: typed domain objects on a blackboard, `@Action`/`@Agent`, GOAP planning | real code; no event sourcing, no commands/policies/sagas, no business-process notation |

The *strategic* ideas (bounded context per agent, typed contracts,
ACLs) are established talking points. What does not exist anywhere we
found: the workshop notation compiling to a **typed,
infrastructure-provisioning term language**. The claim v4 can defend is
narrower and stronger than v2/v3's: nobody has *an actor system whose
behaviors can be prose, model-written code, or plain code behind one
tag*, where the Event Storming board compiles to messages + actors +
front-door code and `tsc` is the completeness check. Treat "first" as
"no known prior art", not proven (§9).

---

## 2. Ground truth — the constructs the mapping lands on

A compressed inventory (verified in source during the research rounds;
updated to the resting model where the canon moved):

- **Process** = the one term kind. Externally
  `In → Effect<Out, BudgetExceeded | Refused, Req>` (`Process.ts:127-139`);
  internally an actor: created by its first message, mailbox-serial,
  addressed by run key `(term, work item)` — world identity rides in
  `In`; there is no durable run object (`Process.ts:43-46`).
- **Verbs** (`ProcessService`): `dispatch` (admit + await = *ask*),
  `send` (admit only = *tell*), `steer(runKey, msg)` (message to a
  running actor — P0), `interrupt` (Scope authority). `run()`/the
  trigger-lift is vestigial once auto-delivery goes; the mailbox drain
  is kernel-internal.
- **Implementation Layers** — one term, interchangeable physics, all
  effectful-constructor form (resources resolved once at Layer build):
  `AI.process(Term, ctor)` (deterministic), `AI.layer(Term)`
  (AI-direct prose), `AI.layer(Term)` + codemode `ToolMode` Layers
  (model-written code), `Layer.effect(Term, impl)` (hand-rolled escape
  hatch).
- **EventSource** = a named broadcast channel: name, schema, channel
  tag, props. Emitting or consuming one puts its channel tag in `Req`,
  so the deployment is obligated (`EventSource.ts:64-74`).
- **`AI.when(X)`** = pure input declaration: types `In`, renders in the
  prose, appears in topology. **No auto-delivery.**
- **`${X}` (unmarked event mention)** = the publish grant: declares "I
  may publish X", joins the `emits` topology, and permits
  typed `ctx.emit(EventSource, payload)`, which writes one durable
  Trace row AND publishes on the typed EventBus. A truly inert mention
  is plain text or `${X.name}`.
- **Exits**: `AI.until(schema)` model-declared + graded;
  `AI.until(source, match)` machine-observed with per-item `match`
  correlation (`Halt.ts:34-57`); `AI.never` perpetual.
- **The Trace**: versioned, deterministically-id'd `KernelEvent`s with
  per-ring `seq`, `cause`, `auth` on every row (`Kernel.ts:32-52`);
  commit is transactional; the kernel commits a run's emitted messages
  atomically with its terminal row.
- **The front door**: `GitHub.consumeRepositoryEvents(props, handler)`
  (`src/GitHub/RepositoryEventSource.ts`) is the exemplar consuming
  call site — it carries the provisioning compile fence (the webhook,
  the secret, the delivery path), and its handler is plain code.
- **Topology** is a pure fold over interpolation (`Topology.ts:16-29`);
  **Stack** is the IaC deployment unit.

---

## 3. The mapping table (v4 verdicts)

Each Event Storming / DDD concept → what it maps to in the resting
model. The rows that moved across v1→v4 are marked; the analysis
subsections keep only what stayed true.

| ES/DDD concept | Resting-model expression | Verdict |
|---|---|---|
| **Domain Event** | a broadcast message: `EventSource` (typed, named channel) + `KernelEvent` (Trace rows); published via typed `ctx.emit`, declared by the unmarked `${X}` mention (the publish grant) | ✅ maps; the typed-emission gap v1 found is the one piece that was built |
| **Command** | an addressed message: a plain schema, delivered by *your* code (`send`/`dispatch`/`steer`) after *your* validation/denial. The command surface is your API/route/tool — never a framework construct | ✅ **a pattern** — v3's `AI.command` splice rejected (§4.3); see §5.1 |
| **Actor** | `Agent` term, or a human via the Ask protocol / chat surface | ✅ maps |
| **Aggregate / Entity** | state in **your DB**, judged in **your transaction** (outside the process); or a **fold over the facts** a long-lived run emitted (`deriveState`, snapshots as caches keyed by `seq`) | ✅ **a pattern** — `AI.Entity` (v2) and `AI.key`+`AI.state` (v3) both rejected (§4.2–§4.3); see §5.2 |
| **Policy** ("whenever X then Y") | a Process — deterministic *or* AI, per its Layer — **fed by the front door** (no self-subscription) | ✅ maps; no macro, no auto-delivery (§5.3) |
| **Saga / Process Manager** | a long-lived run with a machine-observed exit, per-item `match` correlation, and a budget | ✅ maps almost verbatim against Axon's saga contract (§3.6, §5.6) |
| **Read Model** | a projection consumer over emitted facts / the Trace — plain code writing your DB or serving tier | ✅ maps; `service.state(key)` (v3) rejected with `AI.state` (§5.5) |
| **External System** | Tool (outbound) + EventSource/webhook consumer (inbound) pair | ✅ maps — `close_issue`/`IssueClosed` is the exemplar (§3.8) |
| **Anti-Corruption Layer** | the front door's adapter: transport payload → domain message, before delivery | ✅ maps — and is now *doctrine*, not just a pattern (§6.2) |
| **Bounded Context** | a responsibility directory + explicit Layer composition | ✅ **a pattern** — `AI.context` rejected in round 1 (§5.4) |
| **Ubiquitous Language** | the term language itself: schemas + prose are one artifact | ✅ maps *better than anywhere else* (§3.10) |
| **Hot Spot** | — (workshop artifact) | `// HOTSPOT:` comments / lint diagnostics; no construct |
| **Repository / VO taxonomy / Domain Service** | Effect Schema + Layers + plain functions | deliberately not adopted (§8) |

### 3.1 Domain Event — the two-tier split, and the one thing that was built

The two-tier split is real and *correct*: DDD itself distinguishes
domain events (inside the model) from integration events (the published
language crossing contexts). Alchemy's `KernelEvent` rows are the
internal event-sourced record; `EventSource` is the integration tier —
typed, named, schema'd, and *infrastructure-provisioning*.

v1 identified the gap: `ctx.emit("routing", routed)` was stringly, and
no term declared "this process publishes `IssueTriaged`". The fix —
`ctx.emit(EventSource, payload)` producing one durable Trace row AND a
typed EventBus publication — was endorsed in every round and is P0 in
the canon, together with the event-mention publish grant that declares
the
published language inline in the charter (an unmarked `${X}` mention,
nestable inside judgment
prose, like a Tool ref; renders as the event's name — formerly the
`AI.emit(X)` ref, deleted by the §2a signature reduction). This turns the
Trace from "observability rows" into "the org's domain-event stream"
without touching the schema.

One v3 idea survived in modified form: typed domain emissions are
**staged** and committed atomically with the run's terminal row (the
kernel's own commit boundary — never a workflow engine). What did *not*
survive is the state half of that transaction (§4.3).

### 3.2 Command — the honest refutation, now resolved by the front door

A DDD Command has three things a bare `dispatch` doesn't: a name,
validation-with-rejection at the decision point, and a catalog. The
resting model answers each *outside* the process:

1. **A name** — the message schema's tag (`S.TaggedStruct("CloseCase",
   …)`). Instructions are plain schemas; the name lives on the message,
   not on a construct.
2. **Validation-with-rejection** — in the deterministic world, *before*
   anything reaches an actor: the API handler or front door validates,
   consults your DB (in your transaction), and **denies** — a 409
   happens before dispatch. This inverts v1–v3's reading, which
   (following Restate's admit-then-decide) put rejection inside the
   handler post-admission. The resting doctrine: `send` stays
   infallible, and *business* refusal is the outside's job; `Refused`
   survives only as the bounded run's typed give-up (the model
   ratifying "I cannot do this"), never as a business-rule verdict.
3. **A catalog** — the responsibility directory's `commands.ts` +
   `AI.topology`'s derived fold; no manifest.

Commands still appear at a second site: a **Tool invocation by an
agent is a command** (blue sticky issued by a non-human actor) — the ES
"Actor → Command → Aggregate" arc is, in alchemy, "Agent → Tool → world
entity". Any docs vocabulary must cover both message-shaped and
tool-shaped commands.

### 3.3 Actor — verified, unchanged

ES Actors are usually human; alchemy's humans arrive via the Ask
protocol (the same *ask* pattern pointed at a person) and the chat
surface; its model actors are `Agent` terms. The provenance ES
workshops capture with a small yellow sticky is a typed field here:
`auth: { initiator, current }` on every Trace row.

### 3.4 Aggregate — the two species doctrine (retained, now doctrine)

The one genuinely *dangerous* import in the whole exercise would have
been adopting Aggregate without this split. It survives every revision
and is now canon doctrine:

| | World-owned | Org-owned |
|---|---|---|
| Examples | GitHub issue, PR, Zendesk ticket | an escalation, a triage case with no external record |
| Source of truth | **the world's state machine** — the process working on it does NOT get to declare it done | **your DB** (your transaction) or the facts a run emitted (the Trace) |
| Our events are | *observations* (webhook → domain message) | *constitutive* (typed `ctx.emit`) |
| Folded/typed state is | a **belief/cache**, never authority — when a decision matters, ask the world | *the* state — judged outside, in your transaction, or derived by fold |
| Exit style | machine-observed (`AI.until(source, match)`) | model-declared (`AI.until(schema)`) or a world event you emit yourself |
| DDD name for the relationship | Conformist / ACL against an upstream context | a plain aggregate root |

Event-sourcing purism ("the log is truth") holds only in the right
column. The left column is AGENTS.md's reconciler doctrine: observation
> assumption. Never read-state-then-act from outside a serialization
boundary to gate writes.

### 3.5 Policy — verified; the owner's sharpening kept

"Whenever X then Y" decomposes into: the front door observes X
(consuming call site) and delivers to the Process that is Y. What ES
adds is only the *framing* that the policy is a nameable rule — which
matters for topology and NL generation. The owner's round-1 sharpening
stands: *a Policy can be an AI Process too* — the occurrence wiring is
always deterministic code, but the decision inside the rule may itself
be judgment; the Layer decides how smart the rule is (§5.3).

### 3.6 Saga — the mapping is exact

Axon's saga contract against the long-lived run:

| Axon saga (web-sourced) | Alchemy |
|---|---|
| `@StartSaga` on an event | front door observes the event and `send`s the first message — the run is created by it |
| `associationProperty = "orderId"` | run key = `(term, world identity)` + the halt's per-item `match(item, event)` |
| `@SagaEventHandler` reacts mid-flight | `steer(runKey, msg)` — delivered at the iteration boundary |
| dispatches commands via CommandGateway | `send`/`dispatch` on child terms; Tool calls |
| `@DeadlineHandler` — "a Saga needs to have an end" | `AI.budget({ wallClock })` → typed `BudgetExceeded` |
| `@EndSaga` | `AI.until(source, match)` — the world settles the run |

Nothing is missing; the alchemy version is stronger on two axes: the
exit is machine-observed rather than self-declared, and `Refused` types
the give-up path Axon leaves to convention. Teaching "saga" as *the
name* for this shape is worth doing; reifying it is not (§5.6).

### 3.7 Read Model — verified

Three read-model tiers exist, all projections: serving-tier
materialized views (transcripts, timelines); `AI.observe` (covariant,
capability-free trace read); `AI.value(Tag)` (a read model injected
into prose). The ES insight that transfers: green stickies sit
**before** commands — a read model exists to inform a decision. If
deterministic code decides, it reads your DB (or a fold — §5.2); if a
model decides, the read model rides in via `AI.value` or a tool result;
if a human decides, it is a serving-tier view.

### 3.8 External System — verified

The pink sticky decomposes into the pair the org already uses: outbound
= Tool (`CloseIssue`), inbound = webhook consumer producing domain
messages (`IssueClosed`), with the physics layer closing the loop —
"the model CAUSES it, the run settles on OBSERVING it". Cause and
observation are separate typed artifacts, better factored than most DDD
codebases manage.

### 3.9 Bounded Context — the analysis that killed the bundle

Candidates judged in v1 (Stack — wrong granularity, a deployment unit;
Layer graph — anonymous plumbing, not data; Worker — couples model
boundary to placement; source module — right, but unchecked; pure-data
bundle — a God-manifest risk). The owner overruled the bundle:
*"you're taking `AI.context` too literally: we want to be GENERAL and
CAPABLE of modeling this."* The surviving answer: **a responsibility
directory + explicit Layer composition** (§5.4), with the context map
*derivable* — from the module-import graph and from `Req` (consuming a
foreign source puts its channel tag in your requirements, which your
Layer must discharge). The sharp edge preserved: capability-by-omission
must survive any grouping — co-residence grants nothing; only explicit
Layer provision grants.

### 3.10 Ubiquitous Language — the best row on the board

DDD's hardest discipline — keeping the experts' vocabulary and the
code's vocabulary the same artifact — is alchemy's *founding claim*:
the prose is the configuration. Parameters carry their descriptions in
schemas; tools are prose with typed holes; charters interpolate the
language and the renderer delivers it to the model. *In alchemy, the
ubiquitous language is not documentation that drifts — it is the
prompt.* No prior-art row in §1.5 achieves this.

---

## 4. History — the entity/command/state excursion, and why the small model won

This section is the permanent record. Four review rounds explored a
family of DDD-inspired constructs; each was rejected by the owner; the
canon's removed-concepts ledger summarizes the verdicts, and this
section preserves the full reasoning so none of it is relitigated. Read
it before proposing anything construct-shaped in this space.

### 4.1 Round 1 (v1 → v2): `AI.policy`, `AI.context`, `AI.aggregate`

v1 proposed three macros/datatypes:

- **`AI.policy`** — sugar for "whenever X then Y" so a lilac sticky
  compiles to something named. **Rejected**: *"I don't know if I really
  want an `AI.policy` concept — build everything on top of AI.Process
  and flexible deterministic code."* And the macro's `handler`
  parameter would have frozen a deterministic assumption into the
  construct — the owner's own observation was that *a Policy can be an
  AI Process too*.
- **`AI.context`** — a pure-data bounded-context bundle (language,
  commands, events, members) + a composed Layer. **Rejected**: *"you're
  taking `AI.context` too literally: we want to be GENERAL and CAPABLE
  of modeling this. Have good documentation for how to implement it —
  Alchemy code with Processes, APIs and existing EventSources can
  orchestrate exactly this without building a specific DDD
  abstraction."* The bundle would have been a second registry to keep
  in sync with the source tree; the directory has no sync problem, and
  the context map is derivable from imports + `Req`.
- **`AI.aggregate`** — a config object for per-identity state.
  **Rejected** along with the above; everything it configured
  reappeared in later rounds as splices, and then those were rejected
  too (§4.3).

What survived round 1: typed `ctx.emit(EventSource, payload)` (endorsed
verbatim), Command/Policy/Bounded-Context as documented patterns, the
two-species doctrine.

### 4.2 Round 2 (v2 → v3): `AI.Entity` and `decide`/`evolve`

v2's centerpiece was **`AI.Entity`** — a new top-level term kind with a
`{ decide, evolve }` Layer contract (the Chassaing decider imported
wholesale) and per-id sharded rings. **Rejected**, verbatim:

> "I don't understand this at all. What is `evolve`. Why is `decide`
> just there? How is the model/kernel configured? I don't see how this
> implements it with AI at all. I honestly worry about having a top
> level concept called entity, vs just again using Processes since
> processes can have state and instances of themselves. Commands can be
> spliced in and handled deterministically or with AI. … Remember, I
> don't want to implement DDD, i want to build a general
> process-oriented model that DDD can be embedded in."

The three faults, as v3 itself diagnosed them (still correct):

1. **A second process algebra.** `{ decide, evolve }` was a new
   required Layer vocabulary, unlike every other process's one handler
   shape.
2. **No honest AI-direct story.** A model can propose events and a next
   state; a *mandatory deterministic fold* is a property no model Layer
   can inhabit — the construct's centerpiece was code-only by
   construction.
3. **It forced event sourcing on everyone.** Under v2 you could not
   have a stateful process without fold-from-events as your state's
   *definition* — the framework would have been implementing DDD, not
   embeddable by it.

Also in this round, the owner rejected any dependency on
`effect/unstable/workflow` Activities for durable execution: *"I don't
want to use Effect workflows, it brings with a ton of technical debt
and coupling to their decisions which are typically anti-serverless. …
I'd prefer to control that and not impose activities, instead use
**ctx.\* for a durable execution**."* That verdict is permanent
(canon ledger): kernel-owned durability — the Trace is the ledger,
`ctx.*` staged emits commit atomically with the run's terminal, and
(later, for codemode) replay serves completed calls from Trace rows.

### 4.3 Round 3 (v3 → v4): `AI.command`, `AI.key`, `AI.state`, staged state commits

v3 "dissolved Entity into Process" by proposing three charter splices
on the one term kind — and this was still too much framework. The
proposals and their rejections, one by one:

**`AI.command(schema)\`judgement prose\`** — declared a member of the
process's `In` union in the charter, with per-command judgment prose,
so command names were readable off the term. **Rejected**: *denial
belongs outside, before the process* — a command construct pulls
validation/refusal into the actor, where it cannot sit in your DB
transaction, and it couples message schemas to the processes that
handle them. In the resting model, **instructions are plain message
schemas** and the command surface is your API/route/tool handler:
validate, deny (4xx before anything reaches an actor), write your DB,
emit, then deliver. The prose that governs interpretation lives in the
charter as ordinary prose about the messages the actor accepts
(`AI.when(X)` types them); the judgment does not need a per-command
construct.

**`AI.key(param)` + keyed ring families** — named the identity field,
refined the term's ring into a keyed mailbox family (serial per key,
parallel across keys), gave `steer(key, …)` addressing. **Rejected**:
**the run is the instance.** Run identity already *is*
`(term, work item)`; a second identity concept (the key param, the
keyed family as a distinct machine) duplicated it. What survives is the
plumbing that was always underneath: run keys + `steer(runKey, msg)` +
per-item exit correlation + re-admission of settled keys — P0 in the
canon, and *actor* vocabulary rather than DDD vocabulary. A long-lived
thing is a long-lived run with a machine-observed exit, or state in
your DB.

**`AI.state(schema, initial)` + staged transactional state commits** —
durable typed per-instance state via `ctx.state`, committed in the same
transaction as the run's events and terminal. **Rejected**:
**double-entry bookkeeping.** The construct made every stateful process
write state AND emit events explaining it — two records of one fact,
with the framework guaranteeing their consistency. Once everything is a
message and every emission is a durable Trace row, state is a **fold**:
`deriveState(events)` in userland, snapshots as caches keyed by `seq`,
rebuildable, never authority. And where you have a real database, state
never belonged in the process at all — *state lives where transactions
live*. The half of the v3 transaction that survives is the
message half: the kernel commits a run's staged emits atomically with
its terminal row (a kernel obligation, not a user-facing state
construct).

**Refusal-as-fact from inside** (e.g. a scheduler emitting
`FixDeclined`, a Case process failing `Refused` on a business rule) —
explored across rounds 3–4 as "the process judges the command and may
refuse it". **Rejected**: *the process was doing the outside's job.*
Business denial happens in deterministic code before dispatch — the
409, the duplicate-check against your run registry or DB, the
"already closed" guard. `Refused` survives only as the bounded run's
typed give-up: the model ratifying that it cannot achieve the goal, a
run outcome — never a business verdict.

**Auto-delivering triggers** — `AI.on` wiring that subscribed the
process, `AI.every` cron serving, `AI.each` queue serving. **Rejected**
in the final round: hidden framework routing, and underdetermined for
addressed delivery (which run should a comment reach? create or steer
or re-admit? — the framework cannot know; your code can). Delivery is
**always** explicit code: the front door consumes
(`consumeRepositoryEvents` and its siblings — the consuming call site
carries the provisioning compile fence), adapts transport → domain,
denies, and picks the door: `send`/`dispatch` (create) vs
`steer(runKey, …)` (input to a running actor). Platform cron calls
`send`. The §2a signature reduction then finished the job at the
constructor level: `AI.on` was renamed `AI.when` — a pure declaration
(typing `In`, rendering in prose, appearing in topology) — and
`AI.each`/`AI.every` were **deleted outright**, not deprecated;
delivery left the framework entirely.

### 4.4 The resting point (round 4) — what the rejections converged on

Strip every rejected construct and what remains is not a hole — it is
the model:

- The deterministic world was always going to hold the validation, the
  denial, the DB transaction, and the routing; every rejected construct
  was an attempt to move a piece of that *inside* the reactive world,
  and every rejection pushed it back out.
- The reactive world was always going to be actors: created by first
  message, serial mailbox, addressed by `(term, work item)`, producing
  Actions and Messages until an exit settles them. `AI.key` was run
  identity renamed; `AI.state` was the Trace folded eagerly;
  `AI.command` was the front door relocated.
- "Everything is a message" is the unification the DDD vocabulary was
  groping toward: instruction vs event is *tense and address*, not
  type system — the framework never distinguishes them.

The doctrine that makes it hold together (canon §5): delivery is always
code; state lives where transactions live; the world outranks the org's
beliefs; the intelligence budget is legible (grep the constitution for
`AI.layer`); kernel obligations only (mailboxes, turns, atomic commit
of emitted messages + terminal, machine-exit correlation, Ask parks,
budgets/checks/folds).

### 4.5 What survived every round

For fairness to the excursion — it produced real additions:

1. **Typed `ctx.emit(EventSource, payload)` + the event-mention publish
   grant** (formerly the `${AI.emit(X)}` ref) — the
   single highest-leverage small change, proposed in v1, endorsed in
   all four rounds, P0 now.
2. **Run-key plumbing** — `steer(runKey, …)`, per-item
   `AI.until(source, match)` correlation, re-admission of settled keys.
   Pre-dates this design (the DX report's gap list), but the excursion
   proved it load-bearing: it is the actor model's addressing.
3. **The effectful-constructor `AI.process`** (resources resolved once
   at Layer build; bare-function form as sugar) — the W2 convention,
   now canonical.
4. **The two-species doctrine** (§3.4) — world-owned vs org-owned
   state; exits machine-observed wherever the world owns state.
5. **The vocabulary itself** — Command, Event, Policy, Saga, Bounded
   Context, ACL as *teaching names* for shapes the primitives already
   express (§5), and the workshop-to-code grammar (§7).

---

## 5. The embedded patterns — DDD in userland, over the resting primitives

The chapter the tutorial grows from. Each DDD concept, expressed with
zero framework vocabulary. Sketches are illustrative (not type-checked;
§9) and use the canon's surface: plain message schemas, `send` /
`dispatch` / `steer(runKey, msg)`, `ctx.emit` + the event-mention
publish grant, `AI.when`, `AI.until(source, match)`, folds over the
Trace.

### 5.1 Command handler = an API route (or front-door case)

The blue sticky is a plain schema plus the deterministic code that
guards it. Validate, **deny**, write your DB, emit — all in *your*
transaction — then deliver:

```ts
// The command is a message schema. No construct.
export const CloseCase = S.TaggedStruct("CloseCase", {
  caseNumber: S.Number, resolution: S.String, evidence: S.String,
});

// The command SURFACE is your API. Validation and business denial
// happen HERE — before anything reaches an actor.
Http.post("/cases/:id/close", (req) =>
  Effect.gen(function* () {
    const cmd = yield* decodeCloseCase(req);          // validate (transport → domain)
    const db = yield* Database;

    const outcome = yield* db.transaction((tx) =>
      Effect.gen(function* () {
        const kase = yield* tx.cases.get(cmd.caseNumber);
        if (kase === undefined) return { _tag: "NotFound" as const };
        if (kase.status === "closed") return { _tag: "Conflict" as const }; // ← denial: a 409,
        yield* tx.cases.update(cmd.caseNumber, {                            //   never a Refused
          status: "closed", resolution: cmd.resolution,
        });
        yield* tx.outbox.insert(CaseClosed, {         // the event, same txn
          caseNumber: cmd.caseNumber, resolution: cmd.resolution,
        });
        return { _tag: "Closed" as const };
      }),
    );
    if (outcome._tag !== "Closed") return respond(outcome);

    // Delivery is explicit code — steer the actor working this case, if any:
    const followUp = yield* CaseFollowUp;
    yield* followUp.steer(caseKey(cmd.caseNumber), { kind: "closed" });
    return Http.ok;
  }));
```

The same command can arrive through three doors — an HTTP route (above),
a Tool an agent calls (whose impl forwards to the same code), or a test
— and the guard code runs regardless of the door. That was always the
point of "one judge, three doors"; the judge just lives *outside* now,
where the transaction is.

When the judgment inside the guard is genuinely fuzzy ("does this
evidence substantiate the resolution?"), it stays a classifier leaf
*invoked by* the deterministic code — the code decides what the
judgment means:

```ts
const verdict = yield* judgeEvidence.dispatch({ command: cmd, kase });
if (!verdict.accept) return respond({ _tag: "Rejected", reason: verdict.reason });
// ...then the same transaction as above
```

### 5.2 Aggregate / Entity = your DB, or a fold over the facts

**If you have a database** (the normal case): the aggregate is rows,
its invariants are checks in your transaction, and the process never
holds it. §5.1 *is* the aggregate pattern — Case status lives in
`tx.cases`, the "closed cases can't be assigned" rule is an `if` in the
handler.

**If the org's only record is the Trace** (org-owned state with no DB):
state is a **fold over the facts a long-lived run emitted** — the
`deriveState` convention:

```ts
// Userland, pure. The framework neither knows nor cares.
export type CaseEvent =
  | { type: "case.opened"; caseNumber: number; attempt: number }
  | { type: "case.assigned"; caseNumber: number; to: string }
  | { type: "case.closed"; caseNumber: number; resolution: string };

export const initialCaseState: CaseState = { status: "new", attempts: 0 };

export const evolve = (s: CaseState, e: CaseEvent): CaseState => {
  switch (e.type) {
    case "case.opened":   return { ...s, status: "new", attempts: e.attempt };
    case "case.assigned": return { ...s, status: "assigned", assignee: e.to };
    case "case.closed":   return { ...s, status: "closed" };
  }
};

export const deriveCaseState = (events: readonly CaseEvent[]): CaseState =>
  events.reduce(evolve, initialCaseState);
```

Rules of the pattern:

- The events are the typed emissions of the run(s) keyed by this
  identity — read them off the Trace (filter by run key), fold.
- **Snapshots are caches keyed by `seq`** — persist
  `{ state, seq }` wherever convenient, resume the fold from `seq`.
  Rebuildable, never authority.
- **Never read-state-then-act from outside a serialization boundary to
  gate writes** — if a decision must be race-free, make it inside your
  DB transaction (left column of §3.4 doesn't apply; this is org-owned
  state) or inside the single actor whose mailbox serializes it.
- For **world-owned** entities, prefer no local fold at all — ask the
  world (a Tool read). Build a belief fold only when routing needs
  cheap typed hints, and treat it as a hint.

This is Chassaing's decider embedded, not implemented: `evolve` is your
pure function, Given/When/Then tests fall out for free, and an org that
later needs replay-grade event sourcing has the rows. What the resting
model refuses is only making the fold (or any state) a framework
construct.

### 5.3 Policy = a Process fed by the front door

"Whenever X then Y". The occurrence wiring is the front door (always
deterministic code); Y is a Process; the Layer decides how smart the
rule is.

```ts
// The rule, deterministic — the default:
export class TriageOnOpen extends AI.Process<TriageOnOpen>()("TriageOnOpen")`
${AI.when(IssueOpenedItem)} reaches you, route it to ${Triage} unless
our records show it is already being worked.` {}

export const TriageOnOpenLive = AI.process(TriageOnOpen, Effect.gen(function* () {
  const triage = yield* Triage;
  const db = yield* Database;
  return (item, ctx) => Effect.gen(function* () {
    if (yield* db.workedIssues.has(item.number)) return;   // occurrence logic: code
    yield* triage.send(item);
  });
}));

// The SAME rule, AI-judged — when "then Y" is a judgment call:
export const TriageOnOpenLive = AI.layer(TriageOnOpen);     // the only change
```

Delivery to the policy is the front door's job — the webhook consumer
(or cron, or your API) `send`s the item; the policy never
self-subscribes. A policy that needs twelve iterations is a mislabeled
goal process; budget AI policies at one to two.

### 5.4 Bounded Context = a responsibility directory + explicit Layers

```
org/src/
  worker.ts                  # front door: routes + webhook consumers + routing residue
  layers.ts                  # THE CONSTITUTION (all physics, all contexts)
  issues/                    # ← a bounded context
    language.ts              #   Parameters + schemas (the ubiquitous language)
    messages.ts              #   instruction schemas + the EventSources it publishes
    issue-work.ts            #   the IssueWork charter (term + Live)
    triage.ts                #   Triage (term + Live)
    adapters.ts              #   transport payload → domain message (the ACL)
    layers.ts                #   IssuesLive — this context's physics, one value
  coding/                    # ← a capability package: Fix, Engineer, Judge…
  community/                 # ← Support, DocsFlywheel…
```

- **The published language is the module's public surface.** Another
  context consumes `issues`' events by importing from
  `issues/messages.ts` — and only from there (lint-enforceable).
- **The context map is derivable twice over**: from the module-import
  graph, and from the type system — consuming a foreign source puts its
  channel tag in your `Req`, which your Layer must discharge.
- **Physics compose per context, explicitly.** Each context exports one
  Layer; the constitution merges them. Co-residence grants nothing —
  capability-by-omission is satisfied *better* by explicit composition
  than any bundle could:

```ts
// issues/layers.ts
export const IssuesLive = Layer.mergeAll(
  IssueWorkLive, TriageLive, TriageOnOpenLive,
).pipe(Layer.provide(GitHubLive));   // the channel this context consumes

// layers.ts — the org. Grep this file for AI.layer: that list IS the
// org's intelligence budget.
export const OrgLive = Layer.mergeAll(IssuesLive, CodingLive, CommunityLive);
```

- **Reusable trades are capability packages** (`alchemy/Coding`) that
  never subscribe to the world; wiring inputs is what a responsibility
  does.

### 5.5 CQRS read model = a projection consumer, plain code

A read model is deterministic code consuming emitted facts and writing
your read store. No framework projection machinery — the consuming call
site is the same front-door shape as every other consumer:

```ts
// worker.ts init Effect — a projection is just a consumer.
// (Spelled with the same consuming-call-site shape as
// GitHub.consumeRepositoryEvents; the concrete API is the EventSource
// consumer for org-published sources.)
yield* consume(CaseClosed, (event) =>
  Effect.gen(function* () {
    const db = yield* Database;
    yield* db.caseTimeline.append(event.caseNumber, {
      at: event.occurredAt, what: "closed", why: event.resolution,
    });
  }));
```

The kernel-provided views (transcripts, timelines, topology) stay
framework-provided — users are never asked to write a projection to get
a transcript. Greg Young's warning (§1.3) is honored by construction:
CQRS machinery exists *inside* the kernel; the user surface is "write a
consumer when you want a bespoke read shape."

### 5.6 Saga = a long-lived run with a machine-observed exit

Nothing to build; the shape *is* the goal run (§3.6 mapping). The
recipe as docs should state it:

1. The front door observes the initiating event and `send`s the first
   message — the run (the saga instance) is created by it, keyed by the
   world identity.
2. Mid-flight events are `steer(runKey, msg)` — delivered by the front
   door, correlated by *your* routing code.
3. The saga issues commands by calling Tools and `send`/`dispatch`-ing
   other actors.
4. It **must end**: `AI.until(source, match)` with per-item correlation
   where the world owns the terminal state; `AI.budget({ wallClock })`
   as the deadline; `Refused` as the typed give-up.

§6 is this pattern, worked end to end.

### 5.7 The sticky-note table — workshop grammar → primitives + patterns

| Sticky | Compiles to | Fence that catches errors |
|---|---|---|
| Domain Event (orange) | `AI.EventSource(name, schema)` in the context's `messages.ts`; published via `ctx.emit`, declared by the unmarked `${X}` mention | emitting/consuming without providing the channel Layer fails to compile |
| Command (blue) | a tagged struct + the guard code at its door (route/tool/front-door case) | unhandled union member fails `Match.tagsExhaustive`; undeclared collaborators can't be granted |
| Actor (yellow, human) | Ask-protocol surface / chat target | — |
| Actor (yellow, automated) | `Agent` term | capability-by-omission |
| Aggregate (large yellow) | world-owned: the external entity + Tool/consumer pair; org-owned: your DB txn or a `deriveState` fold | machine-observed halts need the source's channel in `Req` |
| Policy (lilac) | a Process fed by the front door — deterministic or AI per Layer | the delivery call site carries the provisioning fence |
| Read Model (green) | a projection consumer; `AI.value(Tag)` for prose; serving views for humans | `AI.value`'s tag joins `Req` |
| External System (pink) | Tool (outbound) + consumer (inbound) + adapter | both tags must be provided |
| Hot Spot (red) | `// HOTSPOT:` comment + lint TODO diagnostic | lint |
| Swimlane / cluster | a responsibility directory + one exported Layer | lint rule-pack (no deep cross-context imports) |

---

## 6. The worked example — a GitHub issue, end to end

The exemplar in its final form. One issue is one case; GitHub owns the
entity; the org reacts. Everything the history chapter rejected is
conspicuously absent — and nothing is missing.

### 6.1 The messages

```ts
// issues/messages.ts — the context's language. Plain schemas: the
// framework never distinguishes instructions from events; the name and
// tense carry the meaning.

// Instructions (addressed messages — delivered by OUR code to a specific actor):
export const IssueItem = S.Struct({
  number: S.Number, title: S.String, body: S.String,
  labels: S.Array(S.String),
});
export const IssueComment = S.TaggedStruct("comment", {
  number: S.Number, author: S.String, body: S.String,
});

// Events (broadcast messages — EventSource is a named broadcast channel):
export const IssueParked = AI.EventSource("issue.parked",
  S.Struct({ number: S.Number, waitingOn: S.String }));
export const FixDispatched = AI.EventSource("fix.dispatched",
  S.Struct({ number: S.Number }));
```

### 6.2 The front door — validate, deny, adapt, deliver

All routing intelligence is here, in code you can read. Denial (the
duplicate check) happens against the org's own records — a run
registry or your DB — *before* anything reaches the actor. The
adapters convert transport payloads (Octokit webhook shapes) to domain
messages: the anti-corruption discipline, applied at every ingress.

```ts
// worker.ts init Effect — the front door. The consuming call site
// carries the provisioning compile fence (webhook, secret, path).
yield* GitHub.consumeRepositoryEvents(
  { owner, repository, events: ["issues", "issue_comment"], secret },
  (event) =>
    Effect.gen(function* () {
      const issueWork = yield* IssueWork;
      const runs = yield* RunRegistry;          // or your DB — the org's records

      switch (event.name) {
        case "issues": {
          if (event.payload.action !== "labeled") return;
          if (event.payload.label?.name !== "ready") return;

          const item = toIssueItem(event.payload.issue);   // adapt: transport → domain
          const key = issueKey(item.number);

          // Denial — outside the process, against our records:
          if (yield* runs.isActive(IssueWork, key)) return; // duplicate: drop it here;
                                                            // at an API door this is the 409
          // Doctrine: key match ⇒ steer; settled key ⇒ re-admit (new run,
          // fold-seeded); else ⇒ new run. No model calls in routing.
          yield* issueWork.send(item);          // create: the first message births the actor
          return;
        }
        case "issue_comment": {
          const key = issueKey(event.payload.issue.number);
          if (!(yield* runs.isActive(IssueWork, key))) return; // nobody home: ignore
                                                               // (or re-admit — your call, in code)
          yield* issueWork.steer(key, {         // input to the RUNNING actor
            kind: "comment",
            author: event.payload.comment.user.login,
            body: event.payload.comment.body,
          } satisfies typeof IssueComment.Type);
          return;
        }
      }
    }),
);
```

### 6.3 The actor — the `IssueWork` charter

A long-lived run: created by the first message, steered by later ones,
settled by the world. `AI.when` declares what it accepts (pure input
declaration — the front door above does the delivering); the unmarked
event mentions declare what it may publish, woven inline where the
prose needs them; the exit is machine-observed with per-item
correlation.

```ts
// issues/issue-work.ts
export class IssueWork extends AI.Process<IssueWork>()("IssueWork")`
One issue is one case, and you own it from the moment its
${AI.when(IssueItem)} reaches you until
${AI.until(GitHub.IssueClosed(repo), (item, ev) => item.number === ev.number)}
— and it is GitHub that closes it, not your claim that you are done.

Read the room before acting: ${SearchIssues} for the issue's history
and its duplicates, and the repository itself through ${Coding.Repo}.
Comments arrive mid-flight — ${AI.when(IssueComment)} lands, treat it
as the conversation moving, not as a restart.

Decide what the issue needs: a question answered in a comment
(${PostComment}), a repro requested, a docs pointer — or a real code
change, in which case hand it to ${Fix} and announce
${FixDispatched} so the schedulers can see the work moving.

When you are blocked — waiting on the reporter, waiting on CI — say so
by publishing ${IssueParked} naming what you wait for, then park; the
next steer wakes you and the round begins from your summary, not the
raw transcript (${AI.fold`carry the case file: what was tried,
what is known, what you wait for`}).

${AI.budget({ iterations: 12, wallClock: "4h" })} is the ceiling for
one admission; a reopened issue is a fresh run with a fresh budget.` {}

export const IssueWorkLive = AI.layer(IssueWork);   // prose is the behavior
```

Notes, each carrying a doctrine:

- **The exit is the world's.** The model's `close_issue` tool call
  *causes* `IssueClosed`; the run settles on *observing* it — per-item
  `match` is what lets one term serve fifty concurrent issues.
- **The event mention IS the publish grant** (unmarked grants, marked
  roles): legal nested inside the judgment prose ("announce
  ${FixDispatched} so the schedulers can see…"), it joins the
  published language, permits `ctx.emit(FixDispatched, …)`, and
  renders as the event's name. World-owned catalog events
  (`GitHub.IssueClosed(repo)`) afford nothing by mention — a process
  can't publish what only the world emits; their inbound use is
  `AI.when`/`AI.until`. A truly inert mention is `${X.name}`.
- **Swap the physics without touching a consumer**: `IssueWorkLive`
  could be `AI.process(IssueWork, ctor)` (deterministic rounds with a
  classifier leaf) or the codemode Layer stack — same tag, same front
  door, same messages.
- **A reopened issue** is the front door's re-admission arm: settled
  key ⇒ new run, fold-seeded from the key's prior Trace, fresh budget.
  The "case file" is the fold + the rows — no durable run object, no
  `AI.state`.

### 6.4 What the deterministic world does with the emitted facts

The org's other halves consume `IssueParked` / `FixDispatched` as
ordinary broadcast messages: a projection consumer appends to the
issues dashboard (§5.5); a nudge policy (§5.3) fed by the front door
chases reporters on parked issues after three days (cron → `send`);
`deriveState` over a key's emitted facts answers "how many attempts has
#123 had?" without any state construct (§5.2). Every one of those is
code someone can read, grep, and test.

---

## 7. The NL → process transformation story

Does the vocabulary make it tractable for a coding agent to compile a
business's natural-language process description (or a workshop
artifact) into typed alchemy code? **Yes — and the resting model makes
the story simpler than v1–v3's**, because the compile target is now
just: messages + actors + front-door code + Layers.

**(a) The grammar is closed and small.** An Event Storming board is
already a typed AST: eight node kinds, fixed edges. §5.7 is the
compilation table; the fences are the type system's.

**(b) Event Modeling's four patterns are the generation procedures.**
Given prose, classify each sentence: state change ("customer places an
order") → a message schema + guard code at a door + an emitted event;
state view ("support sees open tickets") → a projection consumer;
translation ("when Stripe tells us payment cleared") → a consumer +
adapter; automation ("every morning, chase stale reviews") → cron →
`send` to a policy Process. Four procedures + the sticky table are a
complete instruction set.

**(c) The type system is the workshop facilitator.** The classic
failure of NL→code generation is silent incompleteness. Alchemy's `Req`
derivation makes the wiring load-bearing: an event nobody publishes, a
channel nobody provisions, a tool nobody implements, a halt source with
no Layer — each is a compile error the generating agent iterates
against. The loop: storm (or parse prose) → lay out responsibility
directories → emit messages, terms, front-door code, Layers → `tsc` →
repair until green.

**(d) What carries the conventions.** No manifest (rejected round 1);
instead: this report's §5 as the conventions document, its natural
packaging a **Skill** the generating agent activates (the kernel
report's construct); `AI.topology`'s directory-aware fold as the review
artifact; a small lint rule-pack for what the compiler can't see (no
deep cross-context imports; one Layer per context; published sources
live in `messages.ts`).

One honest caveat, unchanged since v1: the fuzzy half does not compile.
"Severity is judged honestly" becomes charter prose whose quality no
fence checks. The generation story is strongest exactly where the
doctrine pushed the design: deterministic spine generated and verified;
prose leaves authored and reviewed (`bp-prose-authoring.md` is the
quality bar).

---

## 8. What NOT to adopt — the standing refusals

The full per-construct reasoning lives in §4 (and the canon's ledger);
this is the quick-reference list, including refusals that predate the
excursion:

- **Any DDD construct**: `AI.command`, `AI.key`, `AI.state`/`AI.var`,
  `AI.Entity`, `AI.aggregate`, `AI.policy`, `AI.context`, a Saga term,
  keyed ring families as a distinct machine — all rejected with
  reasoning preserved in §4. Embedded patterns only.
- **`decide`/`evolve` as a Layer contract** — the decider is a
  documented handler/userland convention (§5.2), never required.
- **A workflow/Activities engine for durable execution** —
  effect/workflow refused (owner, §4.2); durability is kernel-owned:
  the Trace is the ledger, staged emits commit atomically with the
  run's terminal, codemode replay serves completed calls from rows.
- **Auto-delivering triggers** — `AI.on` wiring, `AI.every`/`AI.each`
  serving runtimes (§4.3). Delivery is always code.
- **Business refusal from inside a process** — denial is the outside's
  job; `Refused` is only the bounded run's typed give-up.
- **A durable run/Case object** — run key + Trace + fold already are
  the case file; a resurrected run object is Codex's Session god-object
  (`reassess-exit-conditions.md:94-101`).
- **Uniform log-is-truth semantics** — the two-species doctrine (§3.4)
  is the price of admission for org-owned folds; a process must never
  trust its own Trace about a GitHub issue's state.
- **CQRS as user-facing architecture** — kernel-internal only; users
  write consumers, never projections-to-get-a-transcript.
- **Command buses / mediators / envelope hierarchies** — `send`/
  `dispatch`/`steer` are the bus; correlation/causation/actor already
  ride every Trace row.
- **Cross-instance transactions** — one message, one actor, one commit;
  workflows spanning identities are a Process issuing messages (§5.6).
- **Renames** — `Process` does not become `Saga`; `EventSource` does
  not become `DomainEvent`. DDD vocabulary arrives as teaching names in
  docs, never as churn.
- **Teaching-order inversion** — the ladder stays Tool → Agent → Effect
  code → `AI.process` → charter; the DDD/Event-Storming layer is a
  *second* tutorial ("model a business process"), never a gate.

**How far to go, final answer (v4):** the vocabulary + the typed
emission surface (`ctx.emit(EventSource, payload)`, the event-mention
publish grant) + the run-key plumbing (`steer(runKey, …)`, per-item
`match`, re-admission) + the effectful-constructor convention + this
report's §5 patterns and §6 exemplar as documentation + a small lint
rule-pack.
Zero new term kinds, zero DDD constructs, zero renames, zero runtime
restructuring, zero macros, zero manifests, zero workflow engines.

---

## 9. Honesty notes — what could not be verified

- **Web sources were not deeply audited.** Event Storming colors/levels
  were cross-checked across four independent sources and Chassaing's
  decider against his original post; Wolverine/Axon/Restate/Emmett
  claims rest on official docs + maintainer blogs, not codebase reads.
- **The DDD-for-agents scan is search-bounded** (six 2025–2026 items,
  §1.5). Treat "first" as "no known prior art", not proven.
- **`file:line` citations are historical**: they were verified against
  source during the v1–v3 research rounds; the resting-point build
  (canon §6) moves some of this code, and citations were not
  re-verified for v4.
- **Sketches are illustrative, not type-checked** (constraints forbid
  running `tsc`). In particular: the exact spelling of the org-internal
  event consumer in §5.5 (`consume(CaseClosed, …)`) follows the
  front-door consuming-call-site shape but is not a landed API; the
  `RunRegistry` in §6.2 stands for "your run-activity records" (a
  kernel-derived read or your own DB table) and its API is
  illustrative; `AI.on`/`AI.until`/`AI.emit` renders and derivations
  follow the canon's descriptions, not landed code.
- **Round-4 owner statements are paraphrased from the canon's
  removed-concepts ledger**, not quoted verbatim (unlike the round-1–3
  quotes, which were captured in v2/v3 while fresh). The reasoning is
  the ledger's; the wording is this report's.
- **Costing is qualitative.** "Zero constructs" does not mean zero
  work: the P0 plumbing (typed emit + `AI.emit` ref, `steer(runKey)`,
  per-item `match`, re-admission, declaration-only `AI.on`) is real
  kernel work; the claim defended here is that it is *actor* work the
  model needed anyway, not DDD work.
