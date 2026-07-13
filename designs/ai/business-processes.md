# Business Processes as Code — the canonical decision record

Status: **v4.1 — THE RESTING POINT** (July 2026), after four owner
review rounds plus the signature-reduction round (§2a). This document
is the **canon**: where any other design doc or report disagrees with
this file, this file wins and the other doc is stale. History and deep
analysis live in the reports (see §7).

## 0. The model in one paragraph

**Two worlds, one seam.** The **deterministic world** is plain Effect
code + Alchemy infrastructure: APIs and webhook handlers, validation and
**denial** (a 409 happens before anything reaches a process), routing
and addressing, your database and its transactions, cron, projections
and read models. Nothing there is an AI concept. The **reactive world**
is Processes: **actors whose behavior can be written in prose** (or
model-written code, or plain Effect code — a Layer choice). A Process
is created by its first message (`dispatch`/`send`), accepts messages
afterward (`steer`), and produces **Actions** (tool calls) and
**Messages** (typed emits, sends to other actors) until its exit settles
it — model-declared, machine-observed by a world event, or never
(perpetual). Everything is a message: *instructions* are addressed
messages (plain schemas, no construct), *events* are broadcast messages
(`EventSource` = a named broadcast channel). The framework never
distinguishes them — the message's name and tense carry the meaning,
and the actor's prose interprets it. Delivery is **always** code you
can read: the deterministic world sends; actors react. DDD and Event
Storming are **embedded as patterns** over this model, never
implemented as constructs. The pitch: *an actor system where the
behavior can be written in prose — Erlang/OTP with LLM behaviors,
supervision as Scope + budgets, hot code swap as a redeploy with a
`promptHash` diff, Durable Objects as the actor substrate.*

## 1. The actor mapping (all of it already exists or is P0)

| Actor model | Alchemy |
|---|---|
| Actor | a Process **run** — created by its first message; identity = `(term, work item)` |
| Behavior | the charter (`AI.layer`), model-written code (codemode), or an Effect handler (`AI.process`) — interchangeable Layers behind one tag |
| Mailbox, serial processing | the kernel's admission mailbox + serial drain (already built) |
| `tell` | `send(item)` |
| `ask` (send + await reply) | `dispatch(item)` — and the human **Ask protocol** is the same pattern pointed at a person |
| message to a running actor | `steer(runKey, msg)` — run-key addressing is P0 |
| supervision / kill | Scope, budgets, `interrupt` (parent-child cascade already built) |
| broadcast (pub-sub) | `ctx.emit(EventSource, payload)` → subscribers; an "event" is just a broadcast message |
| virtual actors (exist on first message, addressed by identity) | run identity; one DO per run on the Phase-3 harness |

## 2. The term-language surface (final)

Vocabulary: **Terms are declarations** (Process, Tool, EventSource,
Skill — named things with a definition). What appears inside a
template is an **Expression** — a reference that evaluates to prose at
render time and to types/topology at compile time. ("Splice" is
retired as mechanism-speak.) Each expression earns a sentence (prose
doctrine).

**The governing rule — unmarked grants, marked roles:**

> **An unmarked reference to a term grants its affordance**: `${Tool}`
> → may call, `${Agent}`/`${Process}` → may consult/dispatch,
> `${Event}` → **may publish** (joins `emits` topology, permits
> `ctx.emit(Event, payload)`, contributes the source's channel tag to
> `Req`). **Affordances are owner-sensitive**: a **world-owned** event
> (a provider-catalog source like `GitHub.IssueOpened` — the world
> publishes it, a process never can) has no publish affordance, so its
> bare mention renders as vocabulary (name + schema) and grants
> nothing; only **org-internal** sources afford publishing.
> **Marked expressions declare signature roles** — claims on a
> counterparty: `AI.when` (someone must deliver), `AI.until` (the
> kernel must correlate and settle). A truly inert mention is written
> as plain text or `${X.name}` (interpolating the string — every term
> exposes `name`).

**Expressions render as combinators** — complete grammatical units the
surrounding sentence composes with, never markers the author must
paraphrase. A term owns its rendered clause: an `EventSource` carries a
`description` phrase ("an issue opens in alchemy-run/test-alchemy" —
set by the catalog constructor, so `GitHub.IssueOpened(repo)` controls
its own rendering), and `AI.when(X)` renders as "when {X.description}",
so the charter reads

```ts
`${AI.when(GitHub.IssueOpened(repo))} and the case opens with it: run ${Triage} first …`
// renders: "When an issue opens in alchemy-run/test-alchemy, and the case opens with it: …"
```

The anti-pattern is restating the expression's rendering in adjacent
prose ("`${AI.when(IssueOpened(repo))}` an issue opens, …" says it
twice). Same rule for every expression class: mentions render as nouns
the sentence uses, exits as the condition clause.

The signature — a process is a function, and these expressions are its
type, arranged as {inbound, outbound} × {continuing, terminal}:

|  | continues the run | settles the run |
|---|---|---|
| **inbound** | `${AI.when(X)}` | `${AI.until(X, match)}` |
| **outbound** | `${Event}` (mention = publish grant) | `${AI.until(schema)}` → `Out` |

- **`${AI.when(X)}`** (renamed from `AI.on` — completes the temporal
  family *when/until/never* and drops the auto-wired `onEvent`
  connotation; reads as the sentence's own conjunction: "`${AI.when(X)}`
  a member posts, …"). "I accept broadcast message X": types `In`,
  renders in prose, appears in topology. **No auto-delivery** — ever;
  delivery is always outside code. Rulings: (a) `AI.when` is for
  **broadcast** messages; an *addressed* instruction needs no
  declaration — its plain schema types `In`, delivered by
  `dispatch`/`send`/`steer`. (b) The provisioning compile fence rides
  the consuming call site, so `AI.when` contributes no channel tag to
  `Req` (machine-observed halts and event mentions do — those stay
  process-side). (c) An AI-direct process reads org state through a
  read tool or a front-door-seeded snapshot — never a framework state
  construct.
- **Exits** — `AI.until(schema)` (model-declared, graded),
  `AI.exit(AI.when(source, …))` (machine-observed — a **combinator**
  over the signature's own acceptance expression), `AI.never`
  (health-inviolant perpetual). Three rulings from the exit-ergonomics
  review (owner-decided): (a) **correlation is the catalog's, not the
  charter's** — an `EventSource` carries its natural identity `key`
  ("owner/repo#number" for issue events), declared once by the event
  family; the kernel correlates exits by key equality and the front
  door addresses steers with the SAME key, so the charter never writes
  a `match` callback (explicit `match` survives only as an override).
  (b) **The machine-observed exit is `AI.exit(AI.when(…))`** — it
  repurposes `AI.when` rather than adding a second source-taking form,
  composes (variadic `when` ⇒ multi-source exits for free, which
  `until(source)` could never express; more combinators can slot in as
  needed), and carries prose as a template tag (``AI.exit(AI.when(
  IssueClosed(repo)))`whether the merge closed it or a maintainer
  did` ``), rendering "This run ends when {description} — {prose}" —
  no naked block ever sits in a charter. The old machine-observed
  `AI.until(source, match)` overload is deleted. (c) **Budget leaves
  prose** — a ceiling is the *caller's* operational concern, not
  process doctrine (the same argument that moved denial and routing
  out): `AI.budget({…})` is now a **Layer** provided at composition
  (`AI.layer(Term).pipe(Layer.provide(AI.budget({…})))`) with the
  kernel's default guard as fallback; `BudgetExceeded` is
  unconditionally in `Err` since some ceiling always governs a run.
  This supersedes round-1's "budget renders in prose" for the splice —
  the model can still be told its allowance by kernel prose at
  interpretation, but the *setting* is deployment configuration.
  `AI.check` / `AI.fold` / `AI.concurrency` unchanged.
- **`${Skill}`** — dormant capability bundles (unchanged from the
  kernel report: `Req` upper bound, normative activation protocol).
- **`${Resource}` — infrastructure in prose** (domain-specific prose).
  An Alchemy Resource (e.g. `GitHub.Repository("alchemy", …)`) is a
  legal expression: it renders its **resolved identity** at
  interpretation time (the dynamic-prose seam — Resource attrs are
  `Output`s, resolved when the charter is rendered; `promptHash` is
  stamped per interpretation, so infra drift re-renders the charter =
  hot code swap on redeploy) and creates a **dependency edge** in
  topology. It grants **no capability** — a resource mention is a
  noun; acting on it requires a Tool/Skill that closes over the
  resource (capability-by-omission stands).
- **Scoped event sources.** Provider catalogs are repo/resource-
  *generic*; charters consume *this* resource's events. Providers
  expose scoped constructors — `GitHub.IssueOpened(alchemy)` — an
  `EventSource` **instance** carrying the resource's provisioning
  props: it is what `AI.when` accepts, what the front door's
  `consumeRepositoryEvents(alchemy, …)` provisions, and it aligns the
  compile fence per-resource instead of per-provider.
- **Deleted outright** (not deprecated): `AI.on` (renamed), `AI.emit`
  (subsumed by event mention), `AI.each`, `AI.every` (delivery left
  the framework). Code layout: `Trigger.ts` + `Emit.ts` + `Halt.ts`
  consolidate into `Signature.ts`.

**Verbs** (`ProcessService`): `dispatch`, `send`, `steer(runKey, msg)`,
`interrupt` (+ the Ask protocol). `run()`/the trigger-lift is
vestigial once auto-delivery goes; the mailbox drain is kernel-internal.

### 2a. The signature-reduction round (why v4.1)

Owner review of v4 flagged concept sprawl. Findings: (1) "Trigger" was
a misnomer — nothing triggers; `AI.on/emit/until` are one concept, the
**message signature**, the 2×2 above. (2) `AI.emit` was redundant
markup — the author's sentence already contains the verb ("publish
`${AI.emit(X)}`" says it twice), and mentions already carry default
behavior for every other term kind, so the unmarked-grant rule extends
to events. (3) `on` → `when` for the temporal family and Event-Storming
policy-card voice. Cost accepted knowingly: no linked-but-inert event
mentions (use plain text or `${X.name}`); an accidental grant on a
channel-backed source surfaces as a `Req`/Layer compile error.

The round continued with the **domain-specific prose review** (the
`"Your job is to monitor the ${alchemy} repository…"` use-case), which
added three rulings: (4) the affordance rule is **owner-sensitive** —
bare mention of a world-owned catalog event is inert vocabulary, since
a process cannot publish what only the world emits; inbound use is
always `AI.when`. (5) **Resources are expressions** — resolved
identity + dependency edge, no capability grant. (6) **Scoped event
sources** (`GitHub.IssueOpened(alchemy)`) are the missing piece
between provider catalogs and per-resource charters; named in the
build order. Whether codemode should bind a mentioned resource to a
typed client is deferred to the codemode slice (P1).

**Implementation Layers** (one term, interchangeable physics; all
effectful-constructor form — resources resolved once at Layer build):

```ts
const Live = AI.process(Term, Effect.gen(function* () {   // deterministic
  const dep = yield* Dep;
  return (msg, ctx) => Effect.gen(function* () { ... });
}));
const Live = AI.layer(Term);                              // AI-direct (prose)
const Live = AI.layer(Term).pipe(                         // codemode
  Layer.provide(AI.ToolMode.codemode), Layer.provide(AI.Codemode.local));
const Live = Layer.effect(Term, impl);                    // hand-rolled escape hatch
```

## 3. The removed-concepts ledger (and why)

Explored across review rounds, each **rejected as framework surface**;
the reasoning is preserved so it isn't relitigated:

| Removed | Why | What replaces it |
|---|---|---|
| `AI.command` | denial belongs *outside*, before the process; commands coupled schemas to processes | instructions are plain message schemas; APIs/routes are the command surface; validation in the handler/DB txn |
| `AI.key` + keyed ring families | the run **is** the instance; a second identity concept duplicated run identity | run keys (`(term, work item)`) + `steer(runKey, …)`; long-lived thing = long-lived run with a machine exit, or state in your DB |
| `AI.state` / `AI.var` + staged commits | double-entry bookkeeping — write state AND emit events; once everything is facts, state is a **fold** | your DB (outside; your txn) or userland folds over the Trace (`deriveState` convention; snapshots are caches keyed by `seq`) |
| business refusal from inside (`FixDeclined` emitted by the process) | the process was doing the outside's job | outside code denies (4xx before dispatch); `Refused` survives only as the bounded run's typed give-up |
| auto-delivering triggers (`AI.on` wiring, `AI.every`, `AI.each` runtime) | hidden framework routing; underdetermined for addressed delivery | the front door: `consumeRepositoryEvents` etc. → adapt → `send`/`steer`; platform cron → `send`; the consuming call site carries the provisioning compile fence |
| `AI.policy`, `AI.context`, `AI.aggregate` / `AI.Entity` | DDD implemented instead of embedded | documented patterns: policy = a Process (deterministic OR AI) fed by the front door; bounded context = a responsibility directory + explicit Layers; entity/aggregate = state in your DB or a fold over facts, judged outside or by a process |
| `effect/unstable/workflow` (Activities, DurableDeferred) | anti-serverless coupling; never an owner decision | kernel-owned durability: the Trace is the ledger; `ctx.*` staged emits commit atomically with the run's terminal; codemode replay serves completed calls from Trace rows |

## 4. What survived every round (the additions)

1. **Typed `ctx.emit(EventSource, payload)`** + the event-mention
   publish grant (§2a; formerly the `AI.emit(X)` ref) — one durable
   Trace row AND a typed EventBus publication; the single
   highest-leverage small change, endorsed in all rounds.
2. **Run-key steering + per-item exit correlation + re-admission of
   settled keys** — the P0 plumbing (pre-dates this design; now
   load-bearing for the actor model).
3. **Effectful-constructor `AI.process`** (bare-function form as sugar).
4. From earlier rounds, unchanged: **one kernel with `ToolMode` /
   `CodeExecutor` seams**; **codemode** (confined promise-JS; vendored
   opencode interpreter; durable = deterministic re-execution with the
   **Trace as the memoization ledger**; plan view = derived call graph,
   run view = Trace rows; `eval` etc. as real `AI.Tool` terms);
   **Skills** (universal term + normative activation contract);
   **KernelPrompts.ts dissolved** (each kernel owns its prose;
   control-ref renders belong to `Render.ts`); **prose doctrine**
   (every expression earns a sentence; recipient scoping; block vs
   inline render classes); **responsibility-based layout** (`maintenance/`,
   `support/`, `releases/`, `operations/`) with reusable trades as
   **capability packages** (`alchemy/Coding`) that never subscribe to
   the world.

## 5. Doctrine (the rules that make it hold together)

- **Delivery is always code.** No process self-subscribes. The front
  door validates, denies, adapts (transport → domain message — the
  anti-corruption discipline), and picks the door: `send`/`dispatch`
  (create) vs `steer(runKey, …)` (input to a running actor). Doctrine:
  key match ⇒ steer; settled key ⇒ re-admit (new run, fold-seeded);
  else ⇒ new run. No model calls in routing.
- **The front door may be DERIVED.** Hand-rolling the routing per app
  is boilerplate; a provider integration may ship a **signature-driven
  front-door Layer** — `GitHub.frontDoor(IssueWork)` — that walks the
  term's declarations (`AI.when` sources, the machine-exit source),
  provisions/consumes the wire underneath (`consumeRepositoryEvents`),
  adapts payloads to the catalog schemas, and routes by the
  virtual-actor rule (identity-scoped events key the run —
  `owner/repo#number`; first message for a key creates via `send`,
  later ones `steer(key, …)`; keyless events always `send`). This does
  NOT reintroduce kernel auto-delivery: the Layer is explicit, opt-in,
  world-side code you compose and can read — the declarations are its
  *input*, the kernel remains delivery-free, and a hand-written front
  door remains the escape hatch for custom validation/denial.
- **State lives where transactions live.** If you have a DB: validate +
  write + emit in *your* transaction; processes are pure reactors. If
  you don't: the Trace is the record — derive state as a fold over the
  facts a process emitted; never read-state-then-act from outside a
  serialization boundary to gate writes.
- **The world outranks the org's beliefs** (reconciler doctrine): exits
  machine-observed wherever the world owns state; caches/folds are
  hints; when a decision matters, ask the world.
- **The intelligence budget is legible**: grep the constitution file
  for `AI.layer` to enumerate every prose-driven process; everything
  else is code. Fuzzy judgment is a classifier leaf invoked BY code, or
  a charter doing genuinely open-ended work. Nothing perpetual is an
  LLM.
- **Kernel obligations only**: mailbox loops, turns (Standard or
  codemode presentation), atomic commit of emitted messages + terminal
  row per run boundary, machine-exit correlation (internal EventBus
  read with the halt's `match`), Ask parks, budgets/checks/folds.

## 6. Build order

1. **P0 (this slice — done)**: typed `ctx.emit(EventSource, payload)`;
   effectful-constructor `AI.process`; `steer(runKey, …)` + per-item
   `AI.until(source, match)` correlation; auto-delivery removed; the
   §2a signature reduction (`AI.when`, event-mention publish grant,
   `Signature.ts` consolidation, `AI.on`/`AI.emit`/`AI.each`/`AI.every`
   deleted); align `examples/agent-chat-web`.
2. **P0**: promote the GitHub event catalog + channel out of test
   fixtures into `src/GitHub`, including **scoped event sources**
   (`GitHub.IssueOpened(repo)` — §2a ruling 6); **Resource
   expressions** (render resolved identity at interpretation via the
   dynamic-prose seam, dependency edge in topology, owner-sensitive
   mention gate); re-admission of settled keys; the minimal
   self-hosting vertical (this repo's issues, sandbox account).
3. **P1**: kernel seam refactor (`CompiledTool[]`, `ToolMode`,
   protocol-tool terms, KernelPrompts dissolution); codemode local
   Layer (vendored interpreter bridge); Skills; open gap — a
   deterministic handler (`AI.process`) on a term with a
   machine-observed exit should park after the handler returns and
   wake on steer, like the prose path does.
4. **P1**: the `alchemy/Coding` capability package; Discord provider;
   prose-guide rewrites into the example.
5. **P2/P3**: codemode durable Layer (Trace-as-ledger replay);
   Phase-3 DO harness (one DO per run); human-declared exits; the
   "model a business process" tutorial (DDD/Event Storming embedded —
   the workshop grammar compiles to primitives + patterns, `tsc` as the
   completeness check).

## 7. The document map

- **This file** — the canon.
- [reports/bp-ddd-event-storming.md](./reports/bp-ddd-event-storming.md)
  — DDD/ES research + the full history of the entity/command/state
  excursion and why the small model won; the embedded-patterns chapter.
- [reports/bp-dx-open-source-org.md](./reports/bp-dx-open-source-org.md)
  — the OSS-org DX: process catalog, front door, agents, layout, gaps.
- [reports/bp-kernel-layers-codemode-skills.md](./reports/bp-kernel-layers-codemode-skills.md)
  — kernel decomposition, codemode end to end, Skills, protocol terms.
- [reports/bp-codemode-prior-art.md](./reports/bp-codemode-prior-art.md)
  — source-level survey (opencode, Codex, eve, Cloudflare, …).
- [reports/bp-prose-authoring.md](./reports/bp-prose-authoring.md) —
  how to write term prose; splice grammar; BEFORE/AFTER rewrites.
- [reports/agent-loop-algebra.md](./reports/agent-loop-algebra.md) —
  the formal model (Process ≅ Channel), now annotated with the
  actor/message reading.
- [alchemy-ai-design.md](./alchemy-ai-design.md) — the master design
  (kernel, Trace, serving, Cloudflare harness), with a supersession
  section pointing here.
