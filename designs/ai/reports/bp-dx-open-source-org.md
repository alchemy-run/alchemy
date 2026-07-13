# Business process as code — the DX for running an open-source org

Status: **REVISED v3.1** (2026-07-10), aligned to the canon —
[designs/ai/business-processes.md](../business-processes.md) (v4.1, "the
resting point"). Where this report and the canon disagree, the canon
wins and this report is stale. v3.1 applies the canon's §2a signature
reduction: `AI.on` → `AI.when`; `AI.emit` deleted (an unmarked
`${Event}` mention IS the publish grant); `AI.each`/`AI.every` deleted
outright; `Trigger.ts`/`Emit.ts`/`Halt.ts` consolidate into
`Signature.ts`; "splice" retired in favor of "expression". What v3
changed and why:

- **The rejected constructs are gone.** v2 leaned on the entity
  excursion — keyed, stateful Processes with `AI.key`/`AI.state`/
  `AI.command` splices and staged state commits. The canon's
  removed-concepts ledger rejects all of it: the run **is** the
  instance; durable org state lives in **your database** (validated,
  denied, and written in *your* transaction, before anything reaches a
  process) or is derived as a **userland fold over the Trace**.
  `Backlog` and `Case` are now DB tables + folds (§1.5), not terms.
- **`AI.when(X)` (né `AI.on`) is a pure input declaration.** It types
  `In`, renders in prose, and appears in topology — and delivers
  nothing. The old trigger runtime (kernel auto-subscribe, `AI.every`
  cron serving, `AI.each` queues) is deleted outright — "trigger" as a
  concept is dead; what remains is the **message signature**.
  **Delivery is always code you can read**:
  the front door (§2) validates, denies (4xx before dispatch), adapts
  transport payloads to domain messages, and picks the door — key
  match ⇒ `steer(runKey, msg)`; settled key ⇒ re-admit; else ⇒ new run.
- **Everything is a message.** Instructions are addressed messages
  (plain schemas — there is no command construct); events are broadcast
  messages (`EventSource` = a named broadcast channel). Charters
  declare inputs with `${AI.when(X)}` and published messages by
  **mentioning the event** — an unmarked `${Event}` expression grants
  publish — woven into judgment prose; handlers publish with typed
  `ctx.emit(EventSource, payload)`. Owner-sensitivity (canon §2a):
  world-owned catalog events (`GitHub.IssueOpened(repo)` — only GitHub
  publishes them) afford nothing by mention; they appear only inside
  `AI.when`/`AI.until`. Alchemy Resources are expressions too —
  `"maintain the ${alchemy} repository"` renders the resolved identity
  and adds a dependency edge, never a capability.
- **Codemode is a Layer choice, not a constructor.**
  `AI.layer(term).pipe(Layer.provide(AI.ToolMode.codemode),
  Layer.provide(AI.Codemode.local))` replaces v2's `AI.codemode(term)`
  sketch — one tag, interchangeable physics (§1.2).
- **Denial moved outside.** No process emits a business refusal; the
  front door denies before dispatch. Typed `Refused` survives only as
  a bounded run's give-up (IssueWork's park, §3.1.3).
- **Charters repaired per the prose-authoring guide** (block refs on
  their own lines; input declarations written as declarations, not
  wiring; event mentions woven into the sentences that state when
  publication happens).

Kept from v2 — everything that still stands: the responsibility-based
layout (§6), the capability-package discipline (`alchemy/Coding` —
reusable trades that never subscribe to the world, §3.2), the agent
roster (§4), Skills (§5), the Layer-choice implementation with the
effectful-constructor convention (§1.2–1.4), and the "intelligence
budget is legible" doctrine (grep for `AI.layer`).

Sources (all read; claims about existing code cite file:line):
`examples/agent-chat-web/src/{org,server}.ts`,
`examples/cloudflare-agent/src/tools/Fs.ts`,
`src/AI/{Process,Agent,ProcessContext,Tool,EventSource,Trigger,Halt,
EventBus,Topology,Kernel,Check,Fold,Budget,Ask,index}.ts`,
`src/GitHub/RepositoryEventSource.ts`,
`test/AI/fixtures/org/{processes,agents,tools,vocabulary,github-events,
discord-events}.ts`, `test/AI/fixtures/org/cloudflare/worker.ts`,
`designs/ai/{reassess-proposal,org-chat,alchemy-ai-design,
business-processes}.md`,
`designs/ai/reports/{reassess-exit-conditions,
reassess-deterministic-orchestration,perpetual-vs-goal,
reassess-process-abstraction,bp-ddd-event-storming,
bp-kernel-layers-codemode-skills}.md`.

---

## 0. Verdict up front

**The org is a set of Processes, and a Process is a pure reactive
actor.** From the outside, every business process is `In → Effect<Out,
BudgetExceeded | Refused, Req>` — exactly what `Process.ts:50-61`
already gives us. Internally it is a control loop or an event-driven
loop, which is exactly what the kernel's ring is. The domain reading,
per the canon:

> **Everything is a message.** A Process run is **created by its first
> message** (`send`/`dispatch`), **accepts messages afterward**
> (`steer(runKey, msg)`), and **produces Actions** (tool calls) **and
> Messages** — typed `ctx.emit(EventSource, payload)` broadcasts, and
> world events its tools cause — until its exit settles it.
> *Instructions* are addressed messages (plain schemas, no construct);
> *events* are broadcast messages (`EventSource` = a named broadcast
> channel); the framework never distinguishes them. Whether a given
> Process is deterministic code, AI-written code (codemode), or
> AI-direct (a prose charter) is **not part of its identity** — it is a
> per-term choice made at the Layer, invisible to every consumer.

The whole DX question then reduces to four decisions per process:

1. **What message creates it?** — a domain value the responsibility
   owns (an `IssueItem`, a `PRItem`, a `SupportThread`), never a raw
   webhook payload. The adapter that maps transport → domain message is
   the same move `org.ts:52-62` + `server.ts:43-87` already make with
   `PostThread`.
2. **Who owns the exit?** — machine-observed wherever the world has a
   state machine (`AI.until(IssueClosed, match)`,
   `AI.until(PrSettled, match)` — `Halt.ts:73-76`), model-declared only
   where nobody better exists, never the coordinator.
3. **Which Layer implements it?** — `AI.process` (deterministic, the
   default), codemode (tool-dense open-ended work — `AI.layer` +
   `ToolMode.codemode`), `AI.layer` (genuinely open-ended judgment), or
   bare Agent for the conversation shape. The perpetual-vs-goal litmus
   tests (`perpetual-vs-goal.md` §1.4) decide this mechanically — and
   §1.3 below shows the choice is one line, after the fact, per term.
4. **What are the physics?** — per-agent Layers (sandbox flavor, model
   tier, write authority) and Skills: named, dormant capability bundles
   a process activates on demand (§5; mechanics in the sibling kernel
   report).

The front door is **plain deterministic code — all of it** (§2).
`AI.when(source)` is a pure input declaration: it types `In`, renders in
prose, appears in topology, and delivers nothing. No process
self-subscribes. Every delivery is written by hand at the front door:
validate, deny (4xx before dispatch), adapt the transport payload to
the domain message, then pick the door — key match ⇒ `steer(runKey,
msg)`; settled key ⇒ re-admit (new run, fold-seeded); else ⇒
`send`/`dispatch` a new run. No model calls in routing.

Code is organized **by responsibility, not by mechanic** (§6):
`maintenance/`, `support/`, `releases/`, `operations/` each own their
message types, events, durable state, processes, agents, and physics; the
reusable *trade* — coding — is a capability package (`Fix`, Engineer,
Judge, fs/grep/bash tools, bisect/migration skills) that
responsibilities import and scope with their own repos, budgets, and
physics. Capability packages never subscribe to the world; wiring
world events through the front door is what a responsibility does.

The single biggest DX gap between this catalog and today's `main` is
still **run-key addressing** (per-item exit correlation, `steer(key,
input)`, re-admission of a settled key — `reassess-proposal.md:11-13`,
`Process.ts:34-36`) — now P0 in the canon's build order — plus the
effectful-constructor form of `AI.process`, typed
`ctx.emit(EventSource, payload)` + the event-mention publish grant, and
the reduction of auto-delivery to declaration-only `AI.when`.

---

## 1. The frame: everything is a Process

### 1.1 The domain model: messages in, messages out

Everything is a message; the DX should teach it that way:

- **Instructions** — addressed messages: a Process's `In`, a plain
  schema, no construct. `triage.send(item)` / `triage.dispatch(item)`
  is admission (`Process.ts:52-54` — durable, idempotent, ordered), and
  the front door's adapters construct the message from the transport
  payload. Instructions also flow tool-shaped: an agent that holds
  `${Fix}` can dispatch a Fix; an agent that holds `${CreateIssue}`
  sends a message whose acknowledgement is a world event. There is no
  command bus to build — `dispatch`/`send` and tool calls already are
  one.
- **Events** — broadcast messages: what a Process publishes. Two
  species: **org events** the process emits itself (typed
  `ctx.emit(IssueTriaged, verdict)` — one durable Trace row AND a typed
  EventBus publication the front door can consume and forward), and
  **world events** the process *causes* through tools and then
  observes (`CloseIssue` → GitHub fires `IssueClosed` —
  `org.ts:187-196` demonstrates the physics). A charter declares the
  events it may publish by mentioning them — an unmarked `${X}`
  expression is the publish grant — woven into the judgment prose that
  says when.
- **State lives where transactions live.** If the org has a database,
  the front door validates, denies, and writes in *your* transaction —
  before anything reaches a process — and processes stay pure
  reactors. If it doesn't, the Trace is the record: a run's Trace is
  its event-sourced history (run identity = `(term, work item)`, world
  identity riding in `In` — `Process.ts:43-46`), and durable views
  ("how many Fix runs are in flight?", "how many times has this case
  reopened?") are **userland folds over the Trace** (§1.5). World-owned
  state (a GitHub issue's open/closed, a PR's merged) is never ours; we
  observe it (reconciler doctrine).
- **The loop closes through explicit code.** A process emits; the
  front door (or another deterministic consumer) reads the event and
  sends the next message. `AI.when(X)` in the consumer's charter declares
  *what it accepts* — delivery is still the sender's code. Escalation
  travels **through the world** wherever possible — Support's
  `CreateIssue` fires `IssueOpened`, which the front door turns into a
  Triage dispatch; the coupling audit's ideal ("deleting a ring stops
  its mail; it breaks nothing", `processes.ts:9-13`).

Processes are functions from the outside — you can `yield* Triage` and
call it — but control loops and event-driven loops internally, which is
exactly the kernel's ring (`Kernel.ts:113-141`). Nothing in this model
is a new runtime concept; it is the *reading* the catalog below is
written in.

### 1.2 Implementation is a Layer-level choice

A process term is pure data and a `Context.Service` tag. What varies is
only the **implementation Layer** behind the tag — all forms return
`Layer<Term, …>` and satisfy the same `ProcessService`, so they
interpolate into each other freely (`reassess-proposal.md:114-117`):

| Form | Constructor | When |
|---|---|---|
| **Deterministic** | `AI.process(term, ctor)` (`Kernel.ts:190-216`) | action set enumerable; fuzzy judgment as classifier leaves called BY code. The default. |
| **AI codemode** | `AI.layer(term).pipe(Layer.provide(AI.ToolMode.codemode), Layer.provide(AI.Codemode.local))` *(sibling kernel report)* | open-ended tool-heavy work where the model writing code against the granted tool APIs beats one-call-at-a-time |
| **AI direct** | `AI.layer(term)` (`Kernel.ts:218-235`) | genuinely open-ended coordination/judgment; a `switch` can't be written |
| **Hand-rolled** | `Layer.effect(term, impl)` | the escape hatch: any Effect that produces a `ProcessService` (`Kernel.ts:172-175`: "the kernel default is a convenience, not a privilege") |
| **Bare Agent** | `AI.layer(agentTerm)` | conversation shape: reply is the deliverable, human is the check |

Two conventions this report applies everywhere:

**The effectful constructor.** `AI.process` takes not a bare handler
but *an Effect that yields the handler* — resources and bindings are
resolved once, at Layer build, and the returned closure is the per-item
work. This mirrors exactly how tool Layers are written today
(`Fs.ts:21-29`: `Layer.effect(WriteFile, Effect.gen(function* () { const
bucket = yield* …; return ({ path, contents }) => … }))`):

```ts
export const TriageLive = AI.process(
  Triage,
  Effect.gen(function* () {
    // resolved ONCE, at Layer build — same as WriteFileR2's bucket
    const search = yield* SearchIssues;
    const label = yield* AddLabels;
    const comment = yield* CommentOnIssue;
    const classify = yield* Classify;

    // the handler: one message → one run
    return (item: IssueItem, ctx: AI.ProcessContext) =>
      Effect.gen(function* () {
        /* … the per-item work … */
      });
  }),
);
```

Today's `AI.process(term, handler)` takes the handler directly
(`Kernel.ts:138-141`), so this is a (small, additive) API change —
gap 5 in §7. Everything else about the Layer is unchanged: the
handler's own requirements are the Layer's inputs, discharged by
ordinary Layer composition.

**Typed event emission.** Handlers publish org events as
`ctx.emit(IssueTriaged, verdict)` where `IssueTriaged` is an
`AI.EventSource` — one durable Trace row and a typed EventBus
publication the front door consumes and forwards (delivery is always
code; consumers *declare* acceptance with `AI.when`, the sender's code
delivers). In a charter the same declaration is the unmarked
`${IssueTriaged}` mention — the reference itself grants publish — legal
anywhere in the template, and nested inside the judgment prose that
says when to publish.
Today `ctx.emit` takes a bare string (`ProcessContext.ts:21`); the
typed overload + the mention grant is gap 6 in §7 (P0 in the canon's
build order). A process's published language thereby becomes declared,
greppable data — the `events.ts` inside each responsibility (§6) is
its catalog.

### 1.3 One term, three Layers — the Triage worked example

The same term; only the Layer line changes. First the term — note the
charter reads as a job description whoever executes it, and every
expression sits inside a sentence that explains it:

```ts
// org/src/maintenance/triage.ts
export const TriageVerdict = S.Struct({
  labels: S.Array(S.String),
  duplicateOf: S.optionalKey(S.Number),
  ready: S.Boolean,
  criteria: S.Array(S.String),
});

export class Triage extends AI.Process<Triage>()("Triage")`
Every new issue deserves a first response in minutes, not days.
${AI.when(GitHub.IssueOpened(repo))} a new issue lands, it is your
run — one issue, one run — and the front door hands it to you already
validated. Look for the
issue's siblings before anything else (${SearchIssues} — duplicates
are debt, and the reporter deserves the original thread, not a fork).
A genuine new issue gets labels and acceptance criteria precise
enough that a ${Fix} run could verify them mechanically; an unclear
one gets bounced back with exactly one question. Whatever you decide,
say it on the issue itself (${CommentOnIssue}) — silence reads as
neglect — and publish the verdict as ${IssueTriaged} so the
rest of the org can act on it.

First contact is deliberately cheap; do not research what you can
bounce as the one question.

${AI.until(TriageVerdict)`the issue is labeled, deduped, and either
marked ready with criteria or bounced with exactly one question`}
${AI.budget({ iterations: 4, wallClock: "10m" })}` {}
```

Note the message language is *in the prose*: `AI.when` declares what
the term accepts (it wires nothing — the front door delivers), and the
unmarked `${IssueTriaged}` mention is the publish grant, nested inside
the sentence that says when publication happens and carries the verb —
never a bare list squeezed at the end.

**Choice 1 — deterministic** (`AI.process`). The handler is the
implementation; the charter functions as the reviewable spec (it
renders to no model — there is no model):

```ts
export const TriageLive = AI.process(
  Triage,
  Effect.gen(function* () {
    const search = yield* SearchIssues;
    const label = yield* AddLabels;
    const comment = yield* CommentOnIssue;
    const classify = yield* Classify; // the ONE model leaf

    return (item: IssueItem, ctx: AI.ProcessContext) =>
      Effect.gen(function* () {
        // 1. observe — dedupe by exact match before any model call
        const dupes = yield* search({ pattern: item.title });
        if (dupes.exact) {
          yield* label(item, ["duplicate"]);
          yield* comment(item, `Duplicate of #${dupes.exact.number}.`);
          const verdict = { labels: ["duplicate"],
            duplicateOf: dupes.exact.number, ready: false, criteria: [] };
          yield* ctx.emit(IssueTriaged, verdict);
          return verdict;
        }
        // 2. judge — one typed classifier leaf, deterministic fallback
        //    (the org.ts:111-126 pattern: parse failure ⇒ typed default)
        const verdict = yield* classifyIssue(classify, item, dupes.similar)
          .pipe(Effect.orElseSucceed(() => ({
            labels: ["needs-triage"], ready: false,
            criteria: [] as string[],
          })));
        // 3. act — deterministic; the "ready" label IS the event the
        //    front door forwards to the scheduler (§3.1.2) — through
        //    the world
        yield* label(item, verdict.labels.concat(verdict.ready ? ["ready"] : []));
        if (verdict.criteria.length > 0) {
          yield* comment(item, renderCriteria(verdict.criteria));
        }
        yield* ctx.emit(IssueTriaged, verdict);
        return { ...verdict, duplicateOf: undefined };
      });
  }),
);
```

**Choice 2 — AI codemode** (a Layer choice on the same `AI.layer`, gap
8). The charter renders to the model, the granted tools render as a
typed API catalog, and the model writes code against them. Right when
the action set is enumerable-ish but the sequencing is contextual:

```ts
export const TriageLive = AI.layer(Triage).pipe(
  Layer.provide(AI.ToolMode.codemode),
  Layer.provide(AI.Codemode.local),
);
```

**Choice 3 — AI direct** (`AI.layer`). The charter is the
implementation — the model runs the loop, calling tools one at a time,
and the `AI.until(TriageVerdict)` halt-as-tool ends the run:

```ts
export const TriageLive = AI.layer(Triage);
```

**What does not change across the three** — this is the load-bearing
claim: the tag (`yield* Triage` in any consumer), the input type
(`IssueItem`), the exit type (`TriageVerdict`), the error channel
(`BudgetExceeded | Refused`), the `Req` upper bound (SearchIssues |
AddLabels | CommentOnIssue | Classify), the declared message language
(`AI.when(IssueOpened)` in, the `${IssueTriaged}` mention out — the
term says so, not the Layer), the run identity, the Trace row *types*, and every
downstream interpolation (`${Triage}` in another charter). **What
changes**: who executes the body (your code / model-written code / a
model turn loop), the charter's role (spec vs instructions), cost, and
failure modes. Swapping is one line in the responsibility's
`layers.ts` — a reviewable governance act, not a refactor.

### 1.4 "What if I didn't call `AI.process(Triage)`?"

The owner's question, answered mechanically. `Triage` the class is
*only a tag plus pure term data* — declaring it runs nothing and
registers nothing.

- **No Layer anywhere**: any composition that consumes `Triage` (the
  worker resolving it in its init Effect, another term interpolating
  `${Triage}`) simply does not type-check — an unsatisfied requirement
  at `Effect.provide`, identical to forgetting a tool Layer. The
  fixture worker demonstrates the positive case: resolving the rings
  from context "proves the whole graph closed"
  (`cloudflare/worker.ts:137-144`).
- **`AI.layer(Triage)` on a charter-less term**: legal at the type
  level; the existing lint fires when a prose-requiring path meets a
  term with no prose (`reassess-proposal.md:195-197`). The inverse — a
  charter-ful term under `AI.process` — is fine: the charter is
  documentation and a standing option to swap Layers later.
- **`Layer.effect(Triage, impl)`**: always available. The term is an
  ordinary `Context.Service` tag; `AI.process`/`AI.layer` (with or
  without the codemode `ToolMode`) are conveniences that build the
  ring for you (`Kernel.ts:172-175`).
  A hand-rolled `ProcessService` forgoes the ring machinery (mailbox,
  steer, Trace) unless it builds its own — which is why the
  constructors exist, and why the escape hatch stays open.

The tag does not care which Layer form implements it. That is the whole
point.

### 1.5 Durable org state — your database, or folds over the Trace

Some routing and scheduling decisions need durable state that outlives
any single run: "is issue #123 already being worked?", "how many Fix
runs are in flight?", "how many times has this case been reopened?".
v1 derived these ad hoc from the admission ledger; v2 proposed a keyed,
stateful "Entity" Process (`AI.key`/`AI.state`/`AI.command` splices
with staged state commits). **The canon rejects the entity excursion
entirely** (removed-concepts ledger): the run *is* the instance, and a
second identity/state construct duplicated what already exists. What
replaces it, per the canon's "state lives where transactions live":

- **Your database (the default).** If the org has a DB, the front door
  validates, denies, and writes in *your* transaction — before
  anything reaches a process. The `Backlog` the scheduler consults
  (§3.1.2) and the `Case` file the router consults (§2.3) are plain
  tables owned by deterministic code; capacity math, reopen counts,
  and admission decisions happen in the handler's transaction, and
  the process is dispatched only after the write commits. Nothing
  here is an AI concept.
- **Userland folds over the Trace (when there is no DB).** Once
  everything a process does is facts on its Trace (typed `ctx.emit`
  rows), state is a **fold**: a `deriveState`-convention function from
  the key's Trace rows to the current view, with snapshots as caches
  keyed by `seq`. The reopen count of issue #123 is a fold over the
  `IssueParked`/re-admission facts for that run key — computed where
  it's needed, never double-entry-bookkept alongside the events.
- **A long-lived *thing* is a long-lived run.** Where v2 reached for a
  keyed entity to model "the case for issue #123", the resting model
  says: that is a **run** — created by its first message, addressed by
  `steer(runKey, msg)`, settled by a machine-observed exit
  (`AI.until(IssueClosed, match)`). Its identity is `(term, work
  item)`; its history is its Trace; re-admission of a settled key
  starts a fresh run seeded from the fold.

Never read-state-then-act from outside a serialization boundary to
gate writes: either the decision happens in your DB transaction, or it
happens inside the single serialized actor (the run) that owns the
work. Where an external system already owns the state machine (GitHub
issues, PRs, CI), the world is the source of truth and we only observe
— the reconciler doctrine stands.

---

## 2. The deterministic front door — the doctrine

Design this first, because every process hangs off it. This is the
canon's rule made concrete: **delivery is always code.** No process
self-subscribes; `AI.when` declares acceptance and wires nothing. The
front door — the webhook/API handlers you write — does four things in
order, and each is plain deterministic Effect code:

1. **Validate** — verify the signature, decode the payload, check the
   business preconditions against *your* state (DB or fold).
2. **Deny** — a 409/4xx happens here, *before* anything reaches a
   process. Denial is the outside's job; no process ever emits a
   business refusal.
3. **Adapt** — transport payload → domain message (the anti-corruption
   discipline, §2.2). No raw webhook shape crosses the boundary.
4. **Pick the door** — key match ⇒ `steer(runKey, msg)`; settled key ⇒
   re-admit (new run, fold-seeded); else ⇒ `send`/`dispatch` a new
   run. **No model calls in routing.**

### 2.1 Where webhooks land

On Cloudflare, GitHub deliveries land on the org Worker at a
deterministic per-repo path (`RepositoryEventSource.ts:177-178`), claimed
by the `GitHubRepositoryEventSourceLive` listener before user routes ever
see them (`test/AI/fixtures/org/cloudflare/worker.ts:150-152`). The
delivery is signature-verified (`RepositoryEventSource.ts:73-79`) and
decoded to a typed union — and from there it is handed to **your
consuming code** (`GitHub.consumeRepositoryEvents(props, handler)`),
not auto-delivered to any ring.

So the pipeline is:

```
GitHub → POST /__alchemy/github/{owner}/{repo}   (webhook, provisioned at deploy)
       → verify HMAC, decode (GitHubRepositoryEventSourceLive)
       → consumeRepositoryEvents handler (YOUR code):
           validate + deny (4xx — before any process sees anything)
           adapt: transport payload → domain message
           route: steer(runKey, msg) | re-admit | send/dispatch
```

The **consuming call site carries the provisioning compile fence**:
`consumeRepositoryEvents` requires `GitHub.RepositoryEventSource`,
whose Cloudflare binding provisions the repo webhooks pointing at this
Worker. The term's `${AI.when(GitHub.IssueOpened(repo))}` still earns
its keep — it types the process's `In`, renders in the charter, and
appears in topology — but new issue → new `Triage` run happens because
*the front door's code says so*, and you can read that code.

### 2.2 Instructions are plain message schemas (the adapter discipline)

An instruction needs no construct: it is the process's `In` — a plain
schema — plus the typed `send`/`dispatch` that addresses it. APIs and
routes are the command surface; validation happens in the handler (or
your DB transaction), not in a framework object. The source's schema is
already a distilled domain shape, not the Octokit payload
(`github-events.ts:47-53` — `IssueOpenedEvent` is five fields, not
GitHub's 200). That's the same discipline as `toPostThread`
(`server.ts:37-42`: "no raw Prompt objects leak into deterministic
orchestration"). The rule, stated once:

> **A process's input message is a domain value its responsibility
> owns. Transport shapes (webhook payloads, UI messages, Discord
> gateway frames) are converted at the boundary by a pure adapter, and
> the adapter is versioned with the surface, not with the process.**

This is what makes the message independent of transport: `IssueWork`'s
input is `IssueItem`; whether an `IssueItem` arrives from a webhook, a
slash command, a scheduler dispatch, or a test is invisible to it.

```ts
// org/src/maintenance/messages.ts — this responsibility's message types
export const IssueItem = S.Struct({
  repo: S.Struct({ owner: S.String, repository: S.String }),
  number: S.Number,          // ← world identity; the run key rides here
  title: S.String,
  body: S.String,
  labels: S.Array(S.String),
});
export type IssueItem = typeof IssueItem.Type;

// adapters: one per transport that can produce this message
export const fromIssueOpened = (e: GitHub.IssueOpenedEvent): IssueItem => ({
  repo: { owner: e.owner, repository: e.repository },
  number: e.number, title: e.title, body: e.body, labels: [],
});
export const fromSlashCommand = (cmd: FixCommand): IssueItem => ({ ... });
```

Messages also flow *outward*, tool-shaped: `${Fix}` interpolated in
`IssueWork`'s charter is the *dispatch-a-Fix* instruction made
available to the model; `${CreateIssue}` in Support's template sends a
message whose acknowledgement arrives as a world event. Both are
already typed and already gated by capability-by-omission — nothing to
build.

### 2.3 The three doors — steer, re-admit, new run, all in code

With auto-delivery gone, the front door covers *every* case: the new
work item (issue opened), the message addressed to an
**already-running** run (an issue comment while `IssueWork#123` is
mid-flight), the re-admission of a settled key (issue reopened), and
human commands. Doctrine: *key match ⇒ steer; settled key ⇒ re-admit
(new run, fold-seeded); else ⇒ new run* — kernel-exact, no model call.
It is plain code in the Worker's init Effect:

```ts
// org/src/worker.ts — the front door (plain code, no ring)
yield* GitHub.consumeRepositoryEvents(
  { ...repo, events: ["issues", "issue_comment"], secret },
  (event) =>
    Effect.gen(function* () {
      const triage = yield* Triage;
      const issueWork = yield* IssueWork;
      switch (event.name) {
        case "issues": {
          switch (event.payload.action) {
            case "opened":
              // door 3: no run for this key — create one
              yield* triage.send(fromIssueOpened(event.payload));
              return;
            case "reopened":
              // door 2: settled key — NEW run, same key, seeded from
              // the fold over the key's prior Trace
              // [GAP 3: re-admission — reassess-proposal.md:11-13]
              yield* issueWork.send(fromIssueReopened(event.payload));
              return;
          }
          return;
        }
        case "issue_comment": {
          // door 1: a message addressing an open run steers it
          // [GAP 2: steer is currently keyless — Process.ts:34-36]
          const key = issueKey(event.payload.issue.number);
          yield* issueWork.steer(key, {
            kind: "comment",
            author: event.payload.comment.user.login,
            body: event.payload.comment.body,
          });
          return;
        }
      }
    }),
);
```

Notes on the shape:

- **Denial happens here, or earlier.** A malformed payload, a
  permission failure, a business precondition ("this repo is not
  onboarded") is a 4xx returned from this handler — the process never
  hears about it. Where the org has a DB, the validate-and-write
  happens in your transaction before the `send`.
- `send` (admission-only, `Process.ts:53-54`) is the right verb here —
  the front door never awaits business outcomes; joins belong to
  processes that consume `Out`.
- Idempotency rides on deterministic run identity: a redelivered webhook
  re-admits the same `(term, item)` key and the admission ledger
  deduplicates (`Process.ts:43-46`).
- "Is this run open?" is derivable from the admission ledger; the
  reopen count that lets the scheduler treat a five-times-reopened
  issue differently is a `Case` row in your DB or a fold over the
  key's Trace (§1.5) — consulted here, in code, at admission.
- The steer-vs-new decision never consults a model. The one legitimately
  fuzzy routing question in this whole catalog ("is this Discord message
  a new support question or a follow-up?") is answered by the platform's
  own threading — and where a platform doesn't thread, the doctrine
  allows an optional classifier leaf with a typed fallback (default: new
  run), invoked by this code (`perpetual-vs-goal.md` §3.3).

### 2.4 Judgment call: router-as-code vs router-as-Process

Alternatives considered:

1. **Plain code in Worker init** (sketch above).
2. **A prose-free `AI.process` router ring** — a `Router` term the
   front door `send`s every surface event to, whose handler does the
   switch, gaining Trace rows and steer/interrupt verbs for itself.
3. **A prose router charter** — ruled out unconditionally
   (`reassess-deterministic-orchestration.md` §4: "reserve the LLM for
   the judgments, not the plumbing").

**Recommendation: (1), with (2) as the growth path.** The
exit-conditions report already ruled the perpetual side of the issue
exemplar is "ROUTING, not a coordinator process… Deterministic — no
ring" (`reassess-exit-conditions.md:127-129`); a router ring serializes
all surface traffic through one mailbox for no benefit; and the
observability argument for (2) is weak while the router is 60 lines.
Move to (2) only when the front door grows real policy (retry queues,
cross-repo fan-out, rate-limiting), at which point it earns a Trace of
its own. The litmus: **if the router ever needs `ctx.emit`, promote
it.** Note this is *not* an `AI.policy` construct in either form — it is
a Process (form 2) or plain code (form 1), per the no-new-terms rule
(§8.6).

---

## 3. The catalog, by responsibility

The corrected org model table (`reassess-exit-conditions.md:209-217`)
is the seed; this section grows it to a full OSS org, organized the way
the org itself is (§6): four responsibilities and one imported
capability. Each responsibility opens with its **card** — the messages
it accepts (declared per term via `AI.when`), the messages it publishes
(declared by mention — the unmarked `${Event}` expression is the
publish grant), and the durable state it keeps (DB
tables or folds) — and then commits to a shape per process. Every
process's exit is one of the canon's three: model-declared
(`AI.until(schema)`), machine-observed (`AI.until(source, match)`), or
never (`AI.never`).

Litmus tests applied throughout (`perpetual-vs-goal.md:210-217`): does
anything await the output? can it meaningfully fail? would you ever want
a check? Any yes ⇒ goal run. Servers are topology; jobs are work.

### 3.1 `maintenance/` — stewarding the repositories

The maintainer's job: every issue answered, every PR reviewed, main
always green. This responsibility imports the `coding` capability
(§3.2) and scopes it to the org's repos.

**The card:**

- **Messages accepted** (each declared on its term via `AI.when`;
  delivered by the front door): `IssueItem` (Triage, IssueWork),
  `ReadyIssue` (FixScheduler), `PRItem` (PRReview), `BreakItem`
  (RedSuite); human commands `/fix 123`, `/triage 123` (front door →
  `send`); comments and pushes as steers to open runs.
- **Messages published** (declared by mention in the charter; emitted
  with typed `ctx.emit`): `IssueTriaged`, `FixDispatched`, `FixDeferred`,
  `ReviewPosted`, `CulpritIdentified`, `IssueParked`. World events it
  *causes* via tools: label added, comment posted, PR opened, issue
  closed — each observable by anyone the front door forwards to.
- **World events the front door adapts for it**: `IssueOpened`,
  `IssueLabeled(ready)`, `IssueClosed`, `PullRequestOpened`,
  `PullRequestSettled`, `CheckSuiteFailed/Passed(main)`.
- **Durable state**: the world owns issues, PRs, and CI (we observe,
  never believe our cache — reconciler doctrine). The org keeps `Case`
  (per issue: attempts, park reason, reopen count) and `Backlog` (the
  scheduler's in-flight ledger) as DB tables or folds over the Trace
  (§1.5) — consulted by front-door and handler code, never a term.
- **Processes**: Triage (§3.1.1), FixScheduler (§3.1.2), IssueWork
  (§3.1.3), PRReview (§3.1.4), RedSuite (§3.1.5).

The message flow, one line per process — every `──▶` is front-door
code (§2.3), not a subscription:

```
IssueOpened ──▶ Triage        : label/comment (world) + IssueTriaged (org)
IssueLabeled(ready) ──▶ FixScheduler : Backlog.admit → Fix.send | defer
                                       + FixDispatched/FixDeferred (org)
IssueLabeled(ready) ──▶ IssueWork    : owns the case until IssueClosed (world)
PullRequestOpened ──▶ PRReview       : ReviewPosted (org); parks until PrSettled (world)
CheckSuiteFailed(main) ──▶ RedSuite  : CulpritIdentified (org); exits on CheckSuitePassed (world)
```

#### 3.1.1 Triage — deterministic, one classifier leaf

Term and all three Layer choices shown in full in §1.3 (it is the
worked example). Shape summary: **deterministic** because the action
set is enumerable (search, label, comment, emit) and only
classification is fuzzy — a leaf with a typed fallback. Downstream code
awaits the verdict ⇒ goal. Exit is model-shaped but produced by code —
the handler's return IS the resolution. The `ready` label it applies is
itself the event the front door turns into the next dispatch — through
the world, never a private pipe (`alchemy-ai-design.md:945`).

#### 3.1.2 FixScheduler — one policy, two implementations

The owner: "Is Policy deterministic code? I could imagine Policy being
an AI Process too." Here is the same policy both ways. The *policy* is
"when an issue becomes ready, decide whether it runs now": it accepts
a message (`ReadyIssue`, declared via `AI.when(IssueLabeled(ready))` and
delivered by the front door), consults the org's state (the `Backlog`
table/fold — §1.5), and publishes its decision (`FixDispatched` /
`FixDeferred`). One term:

```ts
// org/src/maintenance/fix-scheduler.ts
export const ScheduleDecision = S.Struct({
  dispatched: S.Boolean,
  reason: S.String,
});

export class FixScheduler extends AI.Process<FixScheduler>()("FixScheduler")`
You decide which ready work actually runs — dispatch is a budget, not
a reflex. ${AI.when(GitHub.IssueLabeled(repo, "ready"))} an issue is
readied, one run weighs that one issue against the backlog's current
shape as the front door read it: at most
three ${Fix} runs in flight, smaller estimates jump the queue, and
anything labeled security or breaking waits for a human (${AskHuman})
no matter how small it looks. Announce a dispatch as
${FixDispatched}; announce a deferral, with its queue position and
reason, as ${FixDeferred} — deferred work that silently rots
is worse than work refused out loud.

${AI.until(ScheduleDecision)`the issue is dispatched, deferred with a
queue position, or escalated`}` {}
```

**Form A — deterministic** (the default; capacity math is not
judgment). `BacklogStore` is a plain service over the org's DB — the
admit decision is judged and recorded in *your* transaction (§1.5),
not in any AI construct:

```ts
export const FixSchedulerLive = AI.process(
  FixScheduler,
  Effect.gen(function* () {
    const fix = yield* Fix;              // the coding capability's tag
    const backlog = yield* BacklogStore; // plain DB service (§1.5)
    return (readied: ReadyIssue, ctx: AI.ProcessContext) =>
      Effect.gen(function* () {
        // admit() judges against current state and records the
        // decision in one DB transaction
        const decision = yield* backlog.admit({
          kind: "readied", issue: readied.number,
          sensitive: readied.labels.includes("security"),
        });
        if (decision.dispatch) {
          yield* fix.send(toFixItem(readied));
          yield* ctx.emit(FixDispatched, { issue: readied.number });
          return { dispatched: true, reason: decision.reason };
        }
        yield* ctx.emit(FixDeferred, {
          issue: readied.number, position: decision.position,
        });
        return { dispatched: false, reason: decision.reason };
      });
  }),
);
```

**Form B — AI-direct** (when the org decides priority genuinely needs
judgment — reading the issue, weighing user pain against estimate):

```ts
export const FixSchedulerLive = AI.layer(FixScheduler);
```

Same tag, same input message, same published events, same `Req`
ceiling — the charter above was written to be executable by either. This is the concrete
answer to "no `AI.policy` concept — build on AI.Process + flexible
deterministic code": the policy *is* a Process, and which kind is a
Layer line. (In v1 this dispatch decision was buried inside the
`Flywheel` charter's prose, `processes.ts:69-71` — pulling it out as
its own term makes it swappable, testable, and observable on its own
Trace.)

#### 3.1.3 IssueWork — AI-direct, machine-observed exit, re-admission

The exemplar from `reassess-exit-conditions.md:103-152`, prose upgraded
per the v2 mandate. **This is a long-lived run, not a keyed entity**:
the case *is* the run — created by the front door's `send`, steered by
comments, settled when the world closes the issue. **Why AI-direct:**
"fix it or answer it" is not enumerable — it may mean a question
answered, a docs pointer, a repro request, or a dispatched `Fix`.
**Why machine exit:** GitHub owns `state: closed`; the model's
`CloseIssue` call is a way of *causing* the event, never a claim
(`org.ts:187-196`).

```ts
// org/src/maintenance/issue-work.ts
export class IssueWork extends AI.Process<IssueWork>()("IssueWork")`
One issue is one case.
${AI.when(GitHub.IssueLabeled(repo, "ready"))} an issue is readied,
the case is yours — one readied issue is
one run — and you own it until the world records it closed; it
is GitHub that closes it, not your claim that you are done. Comments
from the reporter arrive as messages into this same run.

Read the room before acting: ${SearchIssues} for the issue's history
and its neighbors, ${Grep} the code it names. If code must change, do
not edit anything yourself — hand the case to ${Fix} with the
acceptance criteria as its entire spec, and stay on the issue while
it runs. Narrate every state change to the reporter with
${CommentOnIssue}; a case that goes quiet is a case you have dropped.

You may cause the close (${CloseIssue}) only when the fix is merged or
the reporter accepts the answer — and ${AI.check(Judge)`before any
${CloseIssue} call is honored: verify a linked PR actually merged or
the reporter explicitly accepted the answer — run ${Bash} yourself;
the worker's claim of done-ness is not a signal`}. If you cannot
reproduce, say exactly what you tried on the issue, announce the park
as ${IssueParked}, and give up: your reply parks the case
until the reporter returns.

${AI.fold(Scribe)`after each round, distill what was tried and why it
parked into the case file — the next round begins from your summary,
not from the raw transcript`}

One admission is one budget; a reopened issue is a fresh case with a
fresh allowance.

${AI.until(GitHub.IssueClosed(repo), (item, ev) => item.number === ev.number)}
${AI.budget({ iterations: 12, wallClock: "4h" })}` {}

export const IssueWorkLive = AI.layer(IssueWork);
```

- **Correlation is per item** — the `match` predicate on the
  machine-observed halt (`Halt.ts:50-57`) is what lets one term serve
  fifty concurrent issues. Today `match` defaults to "any event settles
  any run", flagged as demo-only in the source (`Halt.ts:52-56`);
  per-item correlation is **gap 1**.
- **Reopen ⇒ re-admit**, same key, new run, fold-seeded, fresh budget
  (`reassess-proposal.md:178-183`). The front door (§2.3) sends it;
  the kernel semantics are **gap 3**. The `Case` reopen count (a DB
  row or a fold over the key's Trace — §1.5) is what lets the
  scheduler treat a five-times-reopened issue differently — state
  consulted at admission, in code, not smuggled into prose.
- **`Refused` is a park, not a failure** — and it is the *only* place
  refusal lives in this catalog (the canon: business denial happens at
  the front door, before dispatch; `Refused` survives only as the
  bounded run's typed give-up). "Cannot reproduce, needs reporter
  input" surfaces as the give-up, announced as `IssueParked` for the
  ops dashboards; the front door turns the next `issue_comment` into a
  re-admission (`reassess-exit-conditions.md:149-152`).
- The check gates *cause*, not exit (`reassess-exit-conditions.md:
  180-183`): the world still owns the exit; the check just refuses to
  let the model close its own issue without evidence.

#### 3.1.4 PRReview — deterministic front, machine-observed exit

**Why deterministic-front:** the review *process* (assign reviewer, post
the review, re-review on new pushes, nag on staleness) is enumerable;
the review *judgment* is the `Reviewer` agent, a leaf. The exit is owned
by GitHub — merged or closed (`reassess-exit-conditions.md:215`).

```ts
// org/src/maintenance/review.ts
const PrSettled = GitHub.PullRequestSettled(repo); // closed|merged  [GAP 4: add source]

export class PRReview extends AI.Process<PRReview>()("PRReview")`
${AI.when(GitHub.PullRequestOpened(repo))} a pull request opens, it
becomes your case — one pull request is one run. Every pull request
gets a substantive review
while it is still warm; announce each posted review as
${ReviewPosted}. New pushes arrive as messages into the open
case and earn a re-review. The case stays open until the world
settles it — merged or closed — however long that takes.

${AI.until(PrSettled, (item, ev) => item.number === ev.number)}
${AI.budget({ wallClock: "7 days" })}` {}

export const PRReviewLive = AI.process(
  PRReview,
  Effect.gen(function* () {
    const reviewer = yield* Reviewer;   // resolved once, at Layer build
    return (item: PRItem, ctx: AI.ProcessContext) =>
      Effect.gen(function* () {
        // round 1 now; later rounds arrive as steers when pushes land
        const verdict = yield* ctx.run(
          "Reviewer",
          reviewer.dispatch(formatReviewTask(item)), // ctx.run: org.ts:131-138
        );
        yield* postReview(item, verdict);
        yield* ctx.emit(ReviewPosted, { number: item.number });
        // …the run then parks until PrSettled arrives for THIS pr [GAP 11]
      });
  }),
);

// front door: a synchronize event steers the open run into a re-review
// (worker.ts, same switch as §2.3 — door 1: key match ⇒ steer)
case "pull_request":
  if (event.payload.action === "synchronize") {
    yield* prReview.steer(prKey(event.payload.number), { kind: "push" });
  }
```

The wrinkle this exposes is structural, not incidental: **a
deterministic handler with a machine-observed exit** means "handler
finishes its work round; the run stays open, steerable, until the world
event settles it." Prose processes got exactly these semantics in
reassessment B ("one work round then park", `reassess-proposal.md:
10-13`); `AI.process` handlers have no defined park state today — the
handler's return is the resolution (`ProcessContext.ts:4-11`). This is
**gap 11**, and PR review is its forcing use case.

CI-failure follow-up on a PR is a steer of the same run (`checkSuite:
failed` → `prReview.steer(key, { kind: "ci-failed", … })`), which the
handler forwards into the Reviewer's next round or bounces to the PR
author as a comment. Main-branch CI failure is a different process
(§3.1.5).

#### 3.1.5 RedSuite — AI-direct, machine exit, first Skill consumer

The standing mandate ("tests green") is the canonical perpetual/goal
pair (`reassess-exit-conditions.md:29`): the mandate is *routing*, each
red-suite episode is a bounded run.

```ts
// org/src/maintenance/red-suite.ts
export class RedSuite extends AI.Process<RedSuite>()("RedSuite")`
${AI.when(GitHub.CheckSuiteFailed(repo, { branch: "main" }))} main
goes red, every open PR is suddenly rebasing onto a broken base.
Treat the failure as a pager, not a ticket: acknowledge fast, diagnose
second, fix third.

Find the breaking commit first; if the failure does not name its
author, activate ${BisectSkill} and let git do the finding. Publish
the finding as ${CulpritIdentified} the moment you have it —
the dashboards correlate red-main minutes with authors and subsystems
from that event. Then take the cheapest road back to green: revert it
(${OpenPullRequest} — a revert needs nobody's permission) or, when
the forward fix is smaller than the revert, dispatch ${Fix} with your
repro as its only acceptance criterion. Never force-push. Tell
#maintainers (${Reply}) what broke and what you did.

Your PR merging is not the discharge; your message is not the
discharge. The suite going green is.

${AI.until(GitHub.CheckSuitePassed(repo, { branch: "main" }))}
${AI.budget({ iterations: 8, wallClock: "2h" })}` {}

export const RedSuiteLive = AI.layer(RedSuite);
```

Shape: AI-direct (small — the judgment is "revert vs fix", genuinely
contextual), machine exit (the CI system owns green), and the first
consumer of a **Skill** (§5): bisect know-how is real but rarely
needed, so it stays dormant until activated. Note the correlation
subtlety: the run key here is the *branch*, not an issue number —
evidence that run keys must be caller-shaped, not hardcoded to numbers
(feeds gap 1's design).

### 3.2 The `coding` capability — imported, then scoped

The owner: "I can imagine coding being a pretty general thing that we
want to provide re-usable tools, skills, agents, processes that can be
repurposed for a specific coding responsibility (scope)." Coding is a
**trade**, not a responsibility — several responsibilities employ it
(maintenance's Fix and RedSuite, releases' website edits, support's
repro sandboxes). So it ships as a library — alchemy-provided,
npm-publishable (`alchemy/Coding` as a module of the alchemy package,
or a standalone `@alchemy.run/coding`) — containing:

- **vocabulary**: `issue`, `pr`, `path`, `pattern`, `command` — the
  Parameters from `test/AI/fixtures/org/vocabulary.ts`, which belong to
  the coding trade, not to any one org (this is where v1's "global
  vocabulary.ts" content actually goes).
- **tools**: `Grep`, `ReadFile`, `EditFile`, `Bash`, `OpenPullRequest`
  (contracts + the `DevBox`/`ReadOnly`/`R2` physics Layers, per
  `Fs.ts`).
- **agents**: `Engineer`, `Judge`, `Scribe`, `Reviewer` — the fixture
  agents (`test/AI/fixtures/org/agents.ts`) are essentially these,
  already written repo-agnostically.
- **skills**: `BisectSkill`, `MigrationSkill` (§5).
- **processes**: `Fix` — the generic bounded coding loop.

**The scoping rule: capability packages never subscribe to the world.**
`Fix` is dispatch-only: its `In` is the issue spec, and every run is
created by an explicit `fix.send(…)` from a responsibility's process
or front door — no `AI.when` of anyone's repo, so importing the package
never changes what a deployment provisions. Wiring world events (the
front door's `consume…` call sites), choosing budgets beyond the
defaults, and providing physics (which checkout the DevBox mounts,
which token, which model tier) is what a *responsibility* does. Two
further scoping mechanisms, both existing machinery:

1. **Layer scoping** — the same `Fix` tag gets different physics in
   different subgraphs: maintenance provides `FixLive` with the org
   repos' DevBox; releases could provide a website-scoped `FixLive` in
   its own composition. Layer provision is scoped, not global — the
   fixture worker already runs two `Bash` physics side by side
   (`cloudflare/worker.ts:43-60`).
2. **Process kinds** — when a responsibility wants its *own term* with
   the capability's scaffolding (different budget, extra constitution),
   the landed kind machinery is the tool: the capability exports a kind
   whose charter scaffolds the signature/checks/budget around an
   `${AI.body}` insertion slot, and the responsibility mints
   `class DocsFix extends Coding.FixKind<DocsFix>()("DocsFix")\`…\``
   (`Process.ts:197-205`, `spliceCharter` at `Process.ts:241-275`).

The `Fix` term itself, prose upgraded:

```ts
// alchemy/Coding — fix.ts (the term; the fixture processes.ts:38-57 is its draft)
export class Fix extends AI.Process<Fix>()("Fix")`
One issue, one loop, one task per iteration. You exist only when
dispatched: your first message is one ${issue} — a spec whose
acceptance criteria are the entire definition of done — and nobody
will thank you for work the criteria did not ask for.
Each iteration, give ${Engineer} a completely fresh context: the
issue, its criteria, CONTRIBUTING.md, and .alchemy/NOTES.md. Carry no
conversation history — the repo and the notes are the only memory
this loop is allowed, which is precisely why
${AI.fold(Scribe)`distill each iteration's lessons into
.alchemy/NOTES.md, successful or not — the notes are what the next
fresh context inherits`}.

${AI.until(PullRequestRef)`every acceptance criterion is checked and
the run resolves with the ${pr} the Engineer opened`}
${AI.check((input) => runAcceptanceSuite(input))} — the suite is the
oracle; no model grades its own homework.
${AI.budget({ tokens: "5M", wallClock: "2h", iterations: 12, stall: 3 })}` {}
```

And the implementation menu — the Layer-level choice again, now in a
capability consumer's `layers.ts`:

```ts
// org/src/maintenance/layers.ts
// physics, today: AI-direct loop over the Engineer agent
export const FixLive = AI.layer(Fix).pipe(
  Layer.provide([EngineerLive, ScribeLive, BashReadOnly]),
);

// physics, when codemode lands: same tag, same Req ceiling — the model
// writes code against the granted tool APIs instead of emitting one
// tool call per turn. Swapping is a Layer choice; nothing upstream knows.
export const FixLive = AI.layer(Fix).pipe(                 // [GAP 8]
  Layer.provide(AI.ToolMode.codemode),
  Layer.provide(AI.Codemode.local),
  Layer.provide([BashDevBox, GrepLive, ReadFileLive, EditFileLive,
                 OpenPullRequestLive, ScribeLive]),
);
```

**Why Fix is codemode's home:** tool-dense (grep/read/edit/bash in
tight loops), open-ended within one bounded goal, and its oracle is
mechanical (`Check.ts:19-29` — a `MachineCheck` running the suite beats
any fuzzy judge). Dispatched by: `FixScheduler` (§3.1.2), `IssueWork`
(via `${Fix}` interpolation), `RedSuite`, and humans (`/fix 123`
through the front door — the fixture worker already shows the typed
HTTP dispatch shape, `cloudflare/worker.ts:154-177`).

### 3.3 `support/` — the community's front door

**The card:**

- **Messages accepted**: `SupportThread` (new Discord thread or
  mention — front door creates the run), follow-up messages as steers
  to the open run; a weekly `void` dispatch (platform cron → front
  door → `send`) for the docs flywheel.
- **Messages published**: `ThreadAnswered`, `DocsGapFound`.
  Escalations travel through the world: `CreateIssue` → `IssueOpened`,
  which the front door turns into a Triage dispatch — no private pipe
  between responsibilities.
- **Durable state**: none — the thread is world-owned (Discord threads
  it for us); run key + Trace + fold are the case file, and this
  responsibility is the proof that durable org state is opt-in.
- **Processes**: Support (bare Agent), DocsFlywheel.

#### Support — bare Agent per thread

**Why bare Agent:** the conversation shape exactly
(`perpetual-vs-goal.md` §1.4: item = message, reply = deliverable,
human = the check). No budget ceremony, no check, no charter — the
agent template IS the process.

```ts
// org/src/support/support.ts
export class Support extends AI.Agent<Support>()("Support")`
You are Alchemy's support engineer on Discord — the first human-facing
surface of this organization, and the only one many users will ever
meet. ${SearchIssues} before you answer anything: most questions have
a sibling, and a workaround with a link beats a fresh explanation.
When a report smells like a bug, reproduce it yourself — ${Bash} in a
clean DevBox — and ${ReadFile} the docs to decide whether the bug is
in the code or in what we told them. A real bug becomes
${CreateIssue} with your repro attached (your repro, not their
description), and your reply is the link; a docs gap becomes
${CreateIssue} labeled docs. Anything touching secrets, state
corruption, or billing goes to ${AskHuman} before you speculate in
public. You never promise timelines. You never say "should work."` {}
```

Routing — all in the front door (§2.3): `Discord.ThreadCreated` →
`send`, new run keyed by `threadId`; follow-up messages in the thread
→ `steer(threadKey, msg)` to that run (the platform threads for us,
so no classifier needed). The Discord provider itself is **gap 9**
(the fixture is explicitly a mock, `discord-events.ts:4-8`).

#### DocsFlywheel — scheduled AI-direct synthesis over observed traces

**Why AI-direct:** "find what confuses people and fix the docs" is
judgment end to end. **Why scheduled goal runs:** each weekly run is
bounded (`In = void`; the platform cron fires a front-door handler
that calls `docsFlywheel.send()` — cron is deterministic-world
plumbing, per the canon), settles with a typed list of filed
artifacts, and can meaningfully give up ("nothing recurred this
week").

```ts
// org/src/support/docs-flywheel.ts
export class DocsFlywheel extends AI.Process<DocsFlywheel>()("DocsFlywheel")`
Once a week you are dispatched to sit with the week's pain: read the
traces of ${AI.observe(Support)} and ${AI.observe(IssueWork)} and
cluster the confusions that recur — three people tripping over the
same edge is a docs bug, not three support cases. For the top cluster
only, either fix the docs yourself (${OpenPullRequest} — the
reference pages are generated from JSDoc, so edit the source, never
the markdown), or, where the fix needs a maintainer's judgment, file
the evidence (${CreateIssue} labeled docs, linking every trace in the
cluster) and announce the gap as ${DocsGapFound}. You have
no authority beyond website/ and docs issues.

${AI.until(S.Array(S.String))`the week's artifact URLs — or an honest
give-up when nothing recurred`}
${AI.budget({ iterations: 6, wallClock: "1h" })}` {}
```

`AI.observe` grants read-only trace access and none of the subject's
capabilities (`perpetual-vs-goal.md` op 6) — the docs process can see
Support's pain but can't touch Support's tools. This is the
`Autoresearch` pattern (`processes.ts:110-123`) pointed at docs instead
of prompts. Note the cross-responsibility observation: support/ reads
maintenance/'s IssueWork traces — observation is the one legal
cross-directory dependency besides world events, precisely because it
grants nothing.

### 3.4 `releases/` — cutting and telling

**The card:**

- **Messages accepted**: `ReleasePush` (front door adapts the push
  webhook); human `/release-notes <tag>` (front door → `send`).
- **Messages published**: `NotesDrafted(pr)`. The release itself is a
  world event (`Push` with the release prefix; later
  `ReleasePublished`).
- **Durable state**: none — the release lives in git/npm; the run is
  the work.
- **Processes**: ReleaseNotes. (Growth/marketing — announcement posts,
  social — is a plausible fifth responsibility later; it would import
  the same `coding` capability for website PRs and live beside
  `releases/`, not inside it.)

```ts
// org/src/releases/release-notes.ts
export class ReleaseNotes extends AI.Process<ReleaseNotes>()("ReleaseNotes")`
${AI.when(GitHub.Push(repo, { branch: "main", titlePrefix: "chore(release):" }))}
a release push lands, the blog post is part of that release, not an
afterthought. Announce the drafted post as
${NotesDrafted} so downstream surfaces can pick it up.

${AI.until(PullRequestRef)`the release blog PR is opened`}
${AI.budget({ iterations: 6, wallClock: "30m" })}` {}

export const ReleaseNotesLive = AI.process(
  ReleaseNotes,
  Effect.gen(function* () {
    const blogger = yield* ReleaseBlogger;  // resolved once
    return (push: ReleasePush, ctx: AI.ProcessContext) =>
      Effect.gen(function* () {
        // deterministic gather: changelog data is API calls, not judgment
        const prs = yield* listMergedPrsSince(lastReleaseTag(push));
        const outcome = yield* ctx.run(
          "ReleaseBlogger",
          blogger.dispatch(formatReleaseTask(push, prs)),
        );
        const ref = yield* extractPrRef(outcome); // typed parse, typed failure
        yield* ctx.emit(NotesDrafted, ref);
        return ref;
      });
  }),
);
```

The `Push` source with a `titlePrefix` filter already exists
(`github-events.ts:114-123`). The `ReleaseBlogger` agent references the
`ReleaseSkill` (§5) for the house style rather than inlining the blog
conventions into its always-on prompt:

```ts
// org/src/releases/release-blogger.ts
export class ReleaseBlogger extends AI.Agent<ReleaseBlogger>()("ReleaseBlogger")`
You write the release's public voice. Read the merged PRs and the
changelog yourself (${ReadFile}, ${SearchIssues}) — never summarize a
summary. Activate ${ReleaseSkill} before touching the blog: it holds
the house style, and your memory of it is not the source of truth.
${OpenPullRequest} when the post is ready; you never push to main.` {}
```

### 3.5 `operations/` — the org watching itself

**The card:**

- **Messages accepted**: `void` (hourly platform cron → front door →
  `send`).
- **Messages published**: `HealthSwept(checks)`, `OpsEscalated(failures)`.
- **Durable state**: optionally an `incidents` table (dedup +
  lifecycle of a failing check across sweeps) — v1 deduped by
  deterministic issue title, which works; a DB table is the cleaner
  home when the org has one (§1.5).
- **Processes**: Health.

**Why deterministic:** health checks are pure observation; the only
fuzzy step (is this anomaly worth waking a human?) is a leaf, and even
that is optional when thresholds suffice.

```ts
// org/src/operations/health.ts
export class Health extends AI.Process<Health>()("Health")`
The hourly health sweep — the platform cron fires a front-door
handler that dispatches one bounded run per sweep.

${AI.until(S.Literals(["ok", "escalated"]))`the sweep completed`}` {}

export const HealthLive = AI.process(
  Health,
  Effect.gen(function* () {
    const asks = yield* AI.AskHub;            // resolved once (Ask.ts:22-26)
    return (_tick: void, ctx: AI.ProcessContext) =>
      Effect.gen(function* () {
        const checks = yield* Effect.all({
          site: probe("https://alchemy.run"),
          webhookLag: webhookDeliveryLag(repo),
          budgetBurn: orgBudgetBurn(),            // kernel trace read
          staleAsks: pendingAsksOlderThan(asks, "24h"),
        }, { concurrency: "unbounded" });
        yield* ctx.emit(HealthSwept, checks);
        const failing = failures(checks);
        if (failing.length === 0) return "ok" as const;
        yield* fileOrBumpOpsIssue(failing); // dedup by deterministic title
        yield* ctx.emit(OpsEscalated, { failing });
        return "escalated" as const;
      });
  }),
);
```

### 3.6 The catalog, one table

| Process | Responsibility | Impl (Layer) | Input message (`In`) — delivered by the front door | Exit (`Out`) — owner | Messages published | LLM surface |
|---|---|---|---|---|---|---|
| Triage | maintenance | `AI.process` | `IssueOpened` → `IssueItem` | `TriageVerdict` — **code** returns it | `IssueTriaged` | 1 classifier leaf |
| FixScheduler | maintenance | `AI.process` **or** `AI.layer` (§3.1.2) | `IssueLabeled(ready)` → `ReadyIssue` | `ScheduleDecision` | `FixDispatched`, `FixDeferred` | none / the charter |
| IssueWork | maintenance | `AI.layer` | `IssueLabeled(ready)` → `IssueItem`; comments steer | `IssueClosed` — **world**, per-item match | `IssueParked` | the charter |
| PRReview | maintenance | `AI.process` + park | `PullRequestOpened` → `PRItem`; pushes steer | `PrSettled` — **world**, per-item match | `ReviewPosted` | Reviewer leaf per round |
| RedSuite | maintenance | `AI.layer` | `CheckSuiteFailed(main)` → `BreakItem` | `CheckSuitePassed(main)` — **world** | `CulpritIdentified` | charter + Bisect skill |
| Fix | coding (scoped by consumers) | `AI.layer` → **codemode Layer** | dispatched `issue` spec (`fix.send`) | `PullRequestRef` — model, machine-checked | — (the PR is the event) | the loop |
| Support | support | bare Agent | `ThreadCreated` / thread messages steer | none — conversation; human is the check | `ThreadAnswered` | the agent |
| DocsFlywheel | support | `AI.layer` | weekly cron → `send(void)` | artifact list — model | `DocsGapFound` | the charter |
| ReleaseNotes | releases | `AI.process` | `Push(chore(release):)` → `ReleasePush` | `PullRequestRef` — code extracts | `NotesDrafted` | ReleaseBlogger leaf |
| Health | operations | `AI.process` | hourly cron → `send(void)` | `"ok" \| "escalated"` — code | `HealthSwept`, `OpsEscalated` | none (leaf optional) |

Reading the table confirms the doctrine held: **every machine-ownable
exit is machine-owned; every LLM is either a leaf invoked by code or a
charter doing genuinely open-ended work; nothing perpetual is an LLM;
every delivery is front-door code** — and now also: every process's
accepted and published messages are named, and one row (FixScheduler)
is honestly implementable either way.

---

## 4. The agent roster and their physics

Agents are the reusable *people*; processes are the *jobs*. Several
jobs share one agent with different positional prose (the
`AI.check(Judge)` template idiom, `Check.ts:54-58`). Where each agent
*lives* follows §6: trade agents in the `coding` package,
responsibility-specific agents beside their processes.

| Agent | Home | Role | Tools (Req ceiling) | Layer physics |
|---|---|---|---|---|
| `Classify` | maintenance | routing/triage leaf | none | haiku-tier model, no sandbox — cheapest possible (`org.ts:88-92` shape) |
| `Engineer` | coding | Fix's worker | Bash, Grep, ReadFile, EditFile, OpenPullRequest | **read-write DevBox container**, sonnet-tier; the only agent with a mutable sandbox |
| `Judge` | coding | positional verifier | Bash, ReadFile | **read-only Bash** — same `Bash` contract, refusing mutation (`cloudflare/worker.ts:43-60`) |
| `Reviewer` | coding (scoped by maintenance) | PR judgment leaf | ReadFile, Reply, Approve | holds the org's only `${Approve}`; `ApproveHuman` vs `ApproveAuto` Layer is the autonomy dial (`cloudflare/worker.ts:66-71`) |
| `Scribe` | coding | fold agent, org memory | CreateIssue, EditFile(.alchemy/NOTES.md) | cheap model; write access scoped to notes |
| `Support` | support | Discord front | SearchIssues, BashReadOnly, ReadFile, CreateIssue, Reply, AskHuman | read-only everything + issue filing |
| `ReleaseBlogger` | releases | release prose | ReadFile, SearchIssues, OpenPullRequest, `${ReleaseSkill}` | write access scoped to `website/` |

The wiring idiom is settled and good — per-agent tool provisioning by
Layer composition, two agents sharing a contract with different physics
side by side (`Kernel.ts:160-171`, `server.ts:114-125`). What v2
changes is *where the constitution lives*: each responsibility owns its
own `layers.ts` (its scoping of the capability, its autonomy dial, its
model tiers), and the org root composes them:

```ts
// org/src/maintenance/layers.ts — this responsibility's constitution
export const MaintenanceLive = Layer.mergeAll(
  TriageLive, FixSchedulerLive, IssueWorkLive, PRReviewLive, RedSuiteLive,
).pipe(
  Layer.provide([
    // the coding capability, SCOPED here: our repos' DevBox, our budgets
    FixLive, EngineerLive, JudgeLive, ScribeLive,
    // the autonomy dial for THIS responsibility
    ReviewerLive /* ApproveHuman today; ApproveAuto is one line */,
  ]),
);

// org/src/org.ts — THE CONSTITUTION: the whole org is four compositions
export const OrgLive = Layer.mergeAll(
  MaintenanceLive, SupportLive, ReleasesLive, OperationsLive,
).pipe(
  Layer.provide([GitHubEventsLive, DiscordEventsLive]),
  Layer.provide(KernelLive),
);
```

**`org.ts` plus the four `layers.ts` files are the org's constitution.**
A PR touching maintenance/layers.ts is a change to who can do what *in
maintenance* — reviewable in isolation; the `AI.topology` fold
(`Topology.ts:82-91`) still renders the whole org chart, now with a
responsibility grouping for free. Capability denial by omission is
unchanged and per-responsibility: no Layer anywhere grants DocsFlywheel
an `Approve` or a mutable `Bash` — its `Req` cannot even ask
(`Process.ts:162-166`).

---

## 5. Skills — dormant capability bundles

### 5.1 The concept and the term

The owner's spec: referencing a Skill grants *access*, not *presence* —
its prose and tools stay out of the context until the process activates
it, and the process can deactivate it to manage its own configuration.

This slots precisely into the established doctrine that **`Req` is a
static upper bound on capability; realization is dynamic within it**
(`reassess-proposal.md:236-241`). A skill's tool tags join the host's
`Req` at interpolation (so the Layer graph must provide the physics —
the compile fence survives), but *exposure* is a runtime toggle, which
the reassessment already blessed as "granted-but-not-exposed is sound"
(`reassess-proposal.md:249-252`). Skills are the model-facing steering
wheel for that filter, plus a context-economy device: the same shape as
Cursor/Claude skills (a one-line index entry; the body loads on use).

Proposed term — a **capability term** like `Tool` (compiled into the
host, never interpreted, no ring; `Tool.ts:13-19` taxonomy):

```ts
// packages/alchemy/src/AI/Skill.ts                      [GAP 10: new term]
export interface Skill<Name extends string, Refs extends any[]> {
  "~alchemy/Kind": "Skill";
  "~alchemy/Name": Name;
  template: TemplateStringsArray;   // the playbook: prose + ${Tool} refs
  refs: Refs;                       // tools (and Parameters) the skill carries
}
// AI.Skill<Self>()("name")`summary line.\n\n…full playbook…` — first
// paragraph = the always-visible index entry; the rest loads on activation.
```

### 5.2 Three example skills — and where they live

Bisect and migration are coding-trade know-how → the `coding` package.
The release playbook is this org's house style → `releases/`.

```ts
// alchemy/Coding — skills/bisect.ts
export class BisectSkill extends AI.Skill<BisectSkill>()("bisect")`
Finding the commit that broke main.

- ${Bash} \`git bisect start <bad> <good>\` with the last green SHA from
  the check-suite payload; drive each step with \`bun vitest run <suite>\`
  scoped to the failing test — never the full suite.
- Timeout every run (\`timeout 240\`); a hang IS a failure signal.
- End with \`git bisect reset\`. Report the culprit SHA + first failing
  test, then deactivate.` {}

// alchemy/Coding — skills/migration.ts
export class MigrationSkill extends AI.Skill<MigrationSkill>()("migration")`
Mechanical codemods across the repository (API renames, Effect version
migrations).

- Enumerate call sites first (${Grep}); write the transform as a script,
  run it once, review the diff — never hand-edit N sites.
- Codemods are deterministic mass transforms: if the diff surprises you,
  the script is wrong, not the file.
- Keep the transform script in scripts/ and cite it in the PR body.` {}

// org/src/releases/release-skill.ts
export class ReleaseSkill extends AI.Skill<ReleaseSkill>()("release")`
Cutting a release of an alchemy repository (versioning, changelog,
release blog).

Full playbook — read only after activating:
- Verify main is green first: ${Bash} \`bun tsc -b\`.
- Blog posts live in website/src/content/docs/blog/YYYY-MM-DD-beta-NN.md;
  frontmatter title is "<version> - <short title>". Lead with headline
  features, fold the tail into "Also in this release", breaking changes
  in a :::caution at the top. Read the two most recent posts for voice
  (${ReadFile}).
- Cite PRs inline as ([#NNN](…)); credit external contributors.
- Open the PR with ${OpenPullRequest}; never push to main.` {}
```

### 5.3 Referencing and activation

A skill is interpolated like any capability — inside a sentence that
says *when it earns its context*:

```ts
export class RedSuite extends AI.Process<RedSuite>()("RedSuite")`
…if the failure does not name its author, activate ${BisectSkill} and
let git do the finding…` {}

export class ReleaseBlogger extends AI.Agent<ReleaseBlogger>()("ReleaseBlogger")`
…Activate ${ReleaseSkill} before touching the blog: it holds the house
style, and your memory of it is not the source of truth…` {}
```

Semantics, stated as the model experiences them (the sibling kernel
report owns the mechanics — synthetic `activate_skill` /
`deactivate_skill` tools, exposure-set threading, fold treatment; each
kernel implements the rendering directly, per the owner's ruling that
there is no shared `kernelPrompts` module):

1. **Dormant:** the host's prompt carries one line per referenced skill
   — its name and summary paragraph. The skill's tools are **not** in
   the toolkit; the playbook body is **not** in the context.
2. **Activate:** the model calls `activate_skill("bisect")`. The tool
   result carries the full playbook prose (a tool result, not a
   system-prompt mutation — prompt-cache doctrine,
   `reassess-proposal.md:246-248`), and from the next turn the skill's
   tool refs are exposed in the toolkit.
3. **Deactivate:** removes the tools from exposure. The playbook text
   stays in history (the fold may compress it) — deactivation manages
   *capability*, not memory.
4. **Types:** the skill's tool tags join the host `Req` (Layer must
   provide `BashDevBox` etc. or it doesn't compile); `AI.topology` shows
   the skill as a child node with its tools, so the org chart displays
   dormant capability honestly.
5. **Trace:** `skill.activated` / `skill.deactivated` are durable rows —
   auditors see exactly when a process was wielding what.

Deterministic handlers don't need any of this — code just calls the
tools it was provided; skills are a *model-context* management device.

**Judgment call — why a new term instead of "an Agent you ask" or "a
Tool returning prose":** a delegate agent has a ring, its own context,
and no way to hand *tools* back to the caller; a prose-returning tool
grants knowledge but can't toggle capability exposure. The pair
(prose + tools, jointly toggled) is exactly one thing, and it is the
thing Cursor-style skills proved out. It also composes with
capability-by-omission: a charter that never interpolates
`${ReleaseSkill}` can never activate it — same fence as everything else.

---

## 6. File layout: responsibilities, not mechanics

### 6.1 The organizing principle

v1's layout had global `events/`, `tools/`, `agents/`, `skills/`, and
`vocabulary.ts` folders with a `contexts/` directory for business
areas. The owner rejected it, correctly: **organize like humans
organize an org — by responsibility, not by mechanic.** Nobody in a
company works in "the events department". Mechanic files *inside* a
responsibility are fine (`maintenance/events.ts` is maintenance's
published language); mechanic folders at the top are not (a global
`events/` is a junk drawer that couples every responsibility to every
other's change traffic).

On the names: the owner floated `coding/`, `issues/`, `marketing/` and
asked for better. Two corrections argued here:

- **"issues" is a surface, not a responsibility.** Issues, PRs, and CI
  are three surfaces of one job — *maintaining the project* — and the
  processes that work them share message types, durable state (the
  `Case` table/fold), and the scoped coding capability. Hence
  `maintenance/`. (If the org grows
  until triage and review deserve separate owners, split then —
  directories are cheap to split when Layer composition is explicit.)
- **"coding" is a trade, not a responsibility.** Maintenance, releases,
  and support all *employ* coding. A trade shared by responsibilities
  is a library (§6.2), not a peer directory — putting `coding/` beside
  `issues/` would invite exactly the cross-directory reach-ins the
  layout exists to prevent.

The four responsibilities of this OSS org, named for the human who
would own them: **`maintenance/`** (the maintainer), **`support/`**
(the support engineer), **`releases/`** (the release manager),
**`operations/`** (the ops engineer). `growth/` (announcements,
social, adoption content) is the natural fifth when the org wants it.

### 6.2 Capability packages vs responsibilities

The split the owner described, made precise:

| | Capability package (`coding`) | Responsibility (`maintenance/`, …) |
|---|---|---|
| **Ships as** | a library — alchemy-provided, npm-publishable | the org's own source |
| **Contains** | trade vocabulary, tool contracts + physics Layers, agents, skills, dispatch-only process terms (Fix) | message types + adapters, event sources, durable-state stores/folds, processes, responsibility-specific agents, `layers.ts` |
| **World events** | **never** — dispatch-only (`send` from consumers) | yes — the front door's `consume…` call sites are what scoping *is* |
| **Budgets/physics** | defaults only | chosen per scope in `layers.ts` |
| **Analogy** | a resource provider (`S3.Bucket`) | your stack |

Alchemy itself provides the first capability package (`alchemy/Coding`
or `@alchemy.run/coding`) — the fixture agents/tools/vocabulary
(`test/AI/fixtures/org/{agents,tools,vocabulary}.ts`) are essentially
its v0 content and should be promoted into it rather than into any
org's tree. Provider *surfaces* — the GitHub event catalog + tools, the
Discord channel — likewise belong in alchemy's provider packages
(`src/GitHub`, `src/Discord`; gaps 4 and 9), not in org code. An org
can of course write private capability packages the same shape
(`org/packages/…`) when a trade recurs across its responsibilities.

### 6.3 The org codebase

```
org/
  alchemy.run.ts                 # the Stack: Worker + DOs + webhooks + secrets
  src/
    org.ts                       # THE CONSTITUTION: composes the four
                                 #   responsibilities' Layers (§4) + kernel + channels
    worker.ts                    # the front door (§2): validate/deny/adapt/route
                                 #   per surface, serving tier; imports each
                                 #   responsibility's route contributions
    maintenance/
      messages.ts                # IssueItem, PRItem, ReadyIssue + adapters (§2.2)
      events.ts                  # IssueTriaged, FixDispatched, ReviewPosted,
                                 #   CulpritIdentified, IssueParked (published language)
      vocabulary.ts              # maintenance-specific Parameters (fine INSIDE)
      case.ts                    # the Case store: DB table or Trace fold (§1.5)
      backlog.ts                 # the BacklogStore: DB table or Trace fold (§3.1.2)
      triage.ts                  # Triage term + TriageLive (deterministic)
      fix-scheduler.ts           # FixScheduler term + both Layer forms
      issue-work.ts              # IssueWork charter
      review.ts                  # PRReview term + handler
      red-suite.ts               # RedSuite charter
      classify.ts                # the classifier leaf agent
      layers.ts                  # MaintenanceLive: scope coding, set the
                                 #   autonomy dial, pick model tiers
    support/
      messages.ts                # SupportThread + Discord adapters
      events.ts                  # ThreadAnswered, DocsGapFound
      support.ts                 # the Support agent
      docs-flywheel.ts           # DocsFlywheel charter
      layers.ts                  # SupportLive: read-only everything + issue filing
    releases/
      messages.ts                # ReleasePush + adapters
      events.ts                  # NotesDrafted
      release-notes.ts           # ReleaseNotes term + handler
      release-blogger.ts         # the ReleaseBlogger agent
      release-skill.ts           # the house-style skill (§5.2)
      layers.ts                  # ReleasesLive: write scoped to website/
    operations/
      health.ts                  # Health term + handler
      events.ts                  # HealthSwept, OpsEscalated
      layers.ts                  # OperationsLive
  test/
    maintenance/… support/… releases/… operations/…
                                 # handler unit tests w/ stub agent Layers
                                 # (the det-orch selling point: coordinators
                                 #  are unit-testable, no model required)

# imported, not in-tree:
#   alchemy/Coding   — Engineer, Judge, Scribe, Reviewer; Grep/ReadFile/
#                      EditFile/Bash/OpenPullRequest + physics; Fix;
#                      BisectSkill, MigrationSkill; issue/pr/path vocabulary
#   alchemy/GitHub   — event catalog + channel Layer + GitHub tools [GAP 4]
#   alchemy/Discord  — gateway channel + sources + Reply           [GAP 9]
```

Rules the layout encodes:

- **A responsibility is self-contained**: its message types, its
  published events, its durable state, its processes, its physics.
  Deleting a directory removes a responsibility and breaks nothing
  else's build — the only legal cross-directory dependencies are world
  events (the front door adapting a world event another responsibility
  *caused*), `AI.observe` (grants nothing), and the shared capability
  packages.
- **Mechanic files inside a responsibility are encouraged** — they make
  its language greppable. `maintenance/events.ts` is the catalog of
  what maintenance tells the org; there is deliberately no global
  registry of events.
- **Terms and their default Layer co-locate** per file (the
  resource-file convention transposed); the responsibility's `layers.ts`
  is where the Layer *choice* is made and reviewed.
- **The two genuinely shared files stay small and boring**: `org.ts`
  composes four Layers; `worker.ts` hosts the front door and serving.
  Both are pure composition plus routing — policy lives in the
  responsibilities.

### 6.4 What one `alchemy deploy` provisions

The fixture worker already demonstrates the whole shape
(`test/AI/fixtures/org/cloudflare/worker.ts:122-196`): the org is a
Layer graph provided onto a Cloudflare Worker's init Effect, and **the
front door's consuming call sites are what obligate provisioning** —
each `GitHub.consumeRepositoryEvents(props, handler)` call requires
`GitHub.RepositoryEventSource`, whose Cloudflare binding provisions
the repo webhooks pointing at this Worker, driven by the union of
consumed events' props, FQN-deduped (`EventSource.ts:20-27`,
`worker.ts:130-131`). The compile fence rides the consumer, per the
canon — not the terms' `AI.when` declarations.

```ts
// org/alchemy.run.ts — sketch
const Stack = Alchemy.Stack("alchemy-org", { providers, state },
  Effect.gen(function* () {
    const worker = yield* OrgWorker;      // src/worker.ts default export
    return { url: worker.url };
  }));
```

One deploy provisions: the **Worker** (front door + serving tier), the
**Ring DO namespace** (one DO per process ring, Phase-3 harness —
`alchemy-ai-design.md:977-990`), the **GitHub webhooks** (one per
`(repo, event)` from the front door's consumed events — note the
webhook set is the union across *responsibilities*' route
contributions, computed identically), **cron triggers** for every
schedule the front door registers (platform cron → `send` — cron is
deterministic-world plumbing), the **DevBox containers** (Engineer's
sandbox), **R2** for cold traces, and the **workspace UI** (the
agent-chat-web serving tier pointed at this org's topology —
`server.ts:187-197`). Editing a charter and redeploying is a governance
act; the `promptHash` diff appears in the PR
(`alchemy-ai-design.md:1007`).

---

## 7. Gap analysis (prioritized)

Every place the catalog above leans on something `main` doesn't have.
P0 blocks the minimal org (issues + PRs); P1 blocks breadth; P2 is
polish. Numbering carried from v2 (v1 numbers in brackets); v3 aligns
each row to the canon's build order and retires the rows the canon
removed.

| # | Gap | Needed by | Evidence it's missing | Priority |
|---|---|---|---|---|
| 1 [3] | **Per-item exit correlation** — `match` on machine halts must key runs individually; today default is "any event settles any run" | IssueWork, PRReview, RedSuite | `Halt.ts:52-56` ("correct for single-run demos"); `reassess-proposal.md:11-13` | **P0** |
| 2 [1] | **Steer by run key** — `steer(key, input)`; today steering addresses the active run only, wrong under `AI.concurrency > 1` | front door (§2.3), PRReview rounds, Support threads | `Process.ts:34-36` ("typed in Phase 2") | **P0** |
| 3 [2] | **Re-admission of a settled key** — new run, same key, fold-seeded, fresh budget | IssueWork reopen, Refused-then-comment park/resume | `reassess-proposal.md:178-183` (defined on paper, no kernel mechanism) | **P0** |
| 4 [6] | **GitHub event catalog + tools promoted to `src/GitHub`** — sources + the `GitHubEvents` channel Layer live in test fixtures; missing sources: `IssueCommented`, `IssueReopened`, `PullRequestSettled`, `CheckSuiteFailed/Passed`, `ReleasePublished` | everything | `test/AI/fixtures/org/github-events.ts:8-13`; `IssueClosed` exists only as the demo source in `org.ts:155-158` | **P0** |
| 5 [new] | **Effectful-constructor `AI.process`** — accept `Effect<(item, ctx) => Effect<Out, Err>>` so resources resolve once at Layer build (the `Fs.ts:21-29` shape); today the bare handler is taken directly | every deterministic process in this report (the W2 convention) | `Kernel.ts:138-141`, `Kernel.ts:190-216` (handler passed directly) | **P0** (small, additive) |
| 6 [new] | **Typed `ctx.emit(EventSource, payload)` + the `${Event}` mention publish grant** — one durable Trace row AND a typed EventBus publication; the charter declares its published language by mentioning the event | every `events.ts`; FixScheduler → dashboards; the responsibility cards | `ProcessContext.ts:21` (`emit(type: string, payload?)`); the canon ranks this the highest-leverage small change | **P0** |
| 6b [new in v3] | **Remove auto-delivery** — `AI.when` (né `AI.on`) is declaration-only (types `In`, renders, topology; delivers nothing); front-door delivery everywhere; `Trigger.ts`/`Emit.ts`/`Halt.ts` consolidate into `Signature.ts` | the whole front door (§2); every card | canon build order P0; today `Trigger.ts:51-56` still auto-subscribes | **P0** |
| 7 [new] | ~~Keyed, stateful Processes (the Entity pattern)~~ — **REMOVED by the canon** (removed-concepts ledger): the run is the instance; no `AI.key`/`AI.state`/`AI.command`. What remains is a *documentation* item: the `deriveState` fold convention (+ `seq`-keyed snapshot caches) for orgs without a DB | Backlog (§3.1.2), Case (§1.5, §2.3), Incident (§3.5) — all served by DB tables or folds today | admission-ledger reads + DB tables already work; no framework mechanism needed | **retired** (doc-only) |
| 8 [5] | **Codemode Layers** — `AI.ToolMode.codemode` + `AI.Codemode.local` provided onto `AI.layer(term)` | Fix (its natural home), Triage choice 2 | sibling kernel report §3 (design in flight) | **P1** |
| 9 [7] | **Discord provider** — gateway/interactions channel Layer + sources | Support, escalations | `discord-events.ts:4-8` ("MOCK: src/Discord does not exist yet") | **P1** |
| 10 [8] | **The Skill term** — term kind, `Req` contribution, activation synthetics, exposure toggling, Trace rows | RedSuite, ReleaseBlogger, Engineer | no `Skill` anywhere in `src/AI/index.ts` | **P1** |
| 11 [4] | **`AI.process` handler + machine-observed halt** — handler-returns-then-park semantics undefined | PRReview (its forcing case), any code-front process with a world exit | `Kernel.ts:138-141` (handler's return IS `Out`); machine exits landed for interpreted charters only (`reassess-proposal.md:10-13`) | **P1** |
| 12 [9] | **Durable harness (Phase 3)** — DO rings, durable admission ledger, parked runs surviving eviction | production; long parks (7-day PR reviews) | `alchemy-ai-design.md` §3 is design-only; `server.ts:104-110` is the in-memory bus | **P1** |
| 13 [10] | **Human-declared exit** (`AI.untilApproved` / Ask-in-halt) | release sign-off variants, high-stakes merges | `reassess-proposal.md:171-179`; "Ask exists; not composable into Halt" (`reassess-exit-conditions.md:163`) | **P2** |
| 14 [11] | **Durable dispatch-queue semantics** — ack/lease for `send`-dispatched Fix items (the queue behind admission, not a framework construct — `AI.each` is deleted) | Fix under crash/redeploy | memory kernel approximates the queue | **P2** |
| 15 [12] | **Budget enforcement breadth** — `usd`/`tokens` metering + stall detection wired end-to-end | all budgeted processes | `Budget.ts:22-28` documents intent; enforcement depth unverified in this read | **P2** |
| 16 [13] | **A `route` helper (optional sugar)** — packaging §2.3's switch | DX polish only; plain code suffices | deliberate non-gap until the front-door pattern stabilizes | **P2** |

Removed by the canon (the removed-concepts ledger settles them — do
not reintroduce): no `AI.command` (instructions are plain schemas;
routes are the command surface), no `AI.key`/keyed ring families (run
keys + `steer`), no `AI.state`/`AI.var`/staged commits (your DB or
folds), no refusal-from-inside (front door denies; `Refused` is only
the bounded give-up), no `AI.policy` (a policy is a Process — §3.1.2),
no `AI.context` (a bounded context is a directory + explicit Layer
composition — §6), no `AI.Entity`/aggregate (state in your DB or a
fold over facts), no shared `kernelPrompts` module (each kernel
implements its prose directly — sibling kernel report).

Build order recommendation (matching the canon §6): **4 → 1 → 2 → 3
(+5, 6, 6b alongside — all small)** unlocks the minimal vertical
(issue opened → front door → triage → ready → scheduler → IssueWork →
Fix → PR → review → merged → issue closed, all machine-exited,
comments steering) — that vertical on the memory kernel is the next
demo, and it is the org running *this repo's* issue tracker in a
sandbox account, the first rung of self-hosting. Then 8 + 10 + 11 in
parallel (independent), then 9, then 12 for production.

---

## 8. DX judgment calls (consolidated)

1. **Router-as-code vs router-as-Process** — code in Worker init;
   promote to a prose-free `AI.process` only when it earns a Trace
   (§2.4). Either way delivery is explicit code — `AI.when` declares
   acceptance and wires nothing.
2. **One process term per issue vs one term serving all issues** — one
   term, many runs. Run identity is `(term, work item)` with world
   identity in `In` (`Process.ts:43-46`); a term-per-issue would be
   data creating structure, which the dynamism report refuses
   permanently (`reassess-proposal.md:260-265`).
3. **IssueWork as umbrella + Fix as inner job vs one merged process** —
   keep two. IssueWork's exit is world-owned and potentially weeks long;
   Fix is a tight, budgeted, machine-checked convergence attempt.
   Merging them couples the case file's lifetime to the coding loop's
   budget and loses the "five reopens = five bounded attempts" property
   (`reassess-exit-conditions.md:200-203`).
4. **Policy as its own term vs policy inlined in a coordinator charter**
   — own term (FixScheduler, §3.1.2). Pulling the dispatch decision out
   of the v1 Flywheel prose makes it swappable between deterministic
   and AI-direct forms, unit-testable, and observable on its own Trace.
   The general rule: when a "whenever X then Y" rule has state or a
   reason worth recording, it is a Process; when it is a pure wire, it
   is one `send` line in the front door and nothing else. Never a new
   `AI.policy` construct.
5. **Organize by responsibility vs by mechanic** — responsibility
   (§6.1). Mechanic folders scale with the *number of constructs*;
   responsibility folders scale with the *org*. Mechanic files inside a
   responsibility keep its language greppable without coupling
   strangers.
6. **Capability package vs copy-paste into each responsibility** —
   package (§6.2), because the trade's agents/tools/skills evolve as a
   unit and orgs should receive that evolution as a version bump. The
   discipline that makes it safe: capability packages never subscribe
   to the world, so importing one never changes what a deployment
   provisions — only responsibilities do that.
7. **PR review: prose vs deterministic front** — deterministic front
   with the Reviewer as a per-round leaf, because review *process* is
   mechanical and review *judgment* is not. Accept that this waits on
   gap 11; the interim prose variant is acceptable but should be marked
   as scaffolding.
8. **Skills vs always-on tool interpolation** — skills, for capability
   that is real but rarely needed. The always-on toolkit stays small,
   the `Req` ceiling stays static, and activation is auditable. Inline
   tools remain right for an agent's bread-and-butter capabilities.
9. **Domain vocabulary as API surface** — one primitive only: typed
   `ctx.emit(EventSource, payload)` + the `${Event}` mention publish grant
   (gap 6). Everything else is *pattern*, not construct: instructions
   are plain schemas + typed `send`/`dispatch` + adapters, policies
   are Processes, bounded contexts are directories + Layer
   composition, entities/aggregates are your DB or folds over facts.
   Renames stay refused (`Process` does not become `Saga`;
   `EventSource` does not become `DomainEvent`).
10. **Where classifier leaves live** — as `Agent` terms (like
    `Classify`, `org.ts:88-92`) rather than raw `generateObject` calls:
    the term shows up in `AI.topology`, gets its own model-tier Layer,
    and keeps the "capability surface = source file" invariant. Reserve
    raw `generateObject` for handler-internal parsing with no
    capability implications.

---

## 9. Honesty notes

- **I did not run anything** (per constraints): no type-check, no
  tests. Sketches were written against the read source of the
  constructors (`AI.Process`/`AI.process`/`AI.until(source, match)`/
  `AI.layer`) and the shipped example's idioms.
- **The effectful-constructor form of `AI.process` (gap 5) does not
  exist yet** — every `AI.process(term, Effect.gen(function* () { …
  return (item, ctx) => … }))` sketch in this report is the *proposed*
  API (now canon §2), written to mirror `Fs.ts:21-29` exactly. Today's
  signature takes the bare handler (`Kernel.ts:190-216`). Likewise
  typed `ctx.emit(EventSource, payload)` + the mention grant (gap 6) and
  declaration-only `AI.when` (gap 6b) are in-flight P0s; the
  deterministic sketches degrade gracefully without them (string-typed
  emit; today's auto-subscribe) but the responsibility cards are
  written against the target state.
- **The three-Layer interchangeability claim (§1.3)** is argued from
  the type structure (`ProcessService` is the common shape;
  `Kernel.ts:172-175`) and `reassess-proposal.md:114-117`, not
  demonstrated by a compiled example — the codemode Layers don't exist
  yet, and whether `AI.layer` on a charter written "to be executable by
  either" (§3.1.2) actually performs is an empirical question for the
  first vertical.
- **The exact inferred `In` union** when a term has both
  `AI.when(IssueLabeled)` and front-door `send` of a different shape
  (§3.1.3) is asserted, not verified — `ProcessIn` unions declared
  payloads (`Process.ts:92-100`), so the adapter must reconcile
  `IssueLabeledEvent` with `IssueItem`; I glossed that seam, as v1 did.
- **`AI.until(source, match)` per-item correlation** sketches compile
  trivially but aren't yet type-safe (`match` types `item` as `any`
  today, `Halt.ts:56`) — part of gap 1's design, not a today-feature.
- **Charter prose was not rendered** — the upgraded charters follow the
  renderer contract as documented (`reassess-proposal.md:121-164`:
  control refs render in place), but I did not run the renderer;
  interpolation-in-mid-sentence for `AI.budget`/`AI.until` renders as
  their value blocks, and whether the surrounding sentences still scan
  after substitution should be golden-tested when these charters are
  ported.
- **Budget enforcement depth (gap 15)** is flagged from doc-comments,
  not from reading `KernelMemory.ts`'s enforcement paths end to end.
- **The Skill authoring surface (§5) is a proposal**, deliberately
  shallow on mechanics (fold interaction, exposure-filter composition,
  persistence across Fix iterations) — the sibling kernel report owns
  those; what's asserted here is only the authoring surface and its
  consistency with the `Req`-upper-bound doctrine.
- **The Backlog/Case store sketches (§1.5, §3.1.2)** assume a plain DB
  service with a transactional `admit` — nothing framework-shaped, but
  the `deriveState` fold convention for DB-less orgs is documented
  convention only, not demonstrated code; the *policy-as-Process*
  point survives regardless of which storage the org picks.
- Line numbers cite the files as read on 2026-07-10. Citations into
  `reassess-exit-conditions.md`, `perpetual-vs-goal.md`,
  `reassess-deterministic-orchestration.md`, and
  `RepositoryEventSource.ts` are carried from v1 (verified then, same
  day); citations into `Process.ts`, `Kernel.ts`, `ProcessContext.ts`,
  `Halt.ts`, `Trigger.ts`, `EventSource.ts`, `org.ts`, `server.ts`,
  `Fs.ts`, and the org fixtures were re-verified for this revision.
