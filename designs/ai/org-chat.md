# Org Chat — the autonomous Discord/Slack

Status: **v1 built** (July 2026) — kinds (`AI.Process(name, definition)`,
`AI.charter`/`AI.body`), `AI.topology`, conversation routing by target
prefix, `run.settled` as the uniform run terminal, and the workspace UI
(derived sidebar, Posts as runs, threads, DMs, authored reply bubbles)
all landed; see `examples/agent-chat-web`. Threads-as-steering (R2),
`steer_run` (R3 coordination), presence, and hosting remain open. Builds on [serving.md](./serving.md)
and [chat-apps.md](./chat-apps.md). Companion rename landed first:
`Loop` → **`Process`** (the agent-loop algebra already said Agent and
Loop denote one object — a Process `In → Run<Out, Err>` — so the
general term now carries the general name; `Agent` is the
kernel-default specialization).

## 0. The goal

Stop building "a chat with an agent." Build **a workspace of
processes**: channels, groups, and agents — Discord/Slack-shaped — where
every channel, group, and agent is an `AI.Process`/`AI.Agent` term
defined in prose-in-code, organized into a hierarchy by interpolation,
and the UI is *generated from the term graph*. A message arriving in a
channel doesn't hit a hardcoded router; it triggers the **Channel
process**, whose charter simulates a real channel: who would answer
this? should this open a thread? should two agents take it in parallel?
should the early finisher's answer steer the slow one?

The demo org replaces the dice parlor: a small software team —
`#support` (triage channel), `#engineering` (two engineer agents + a
reviewer), a `Helpdesk` group — running locally, later hosted on
Workers.

## 1. Why this is barely an extension

Almost everything the goal needs already exists, because the primitives
were designed org-first:

| Discord concept | Existing primitive |
| --- | --- |
| Channel | a perpetual `Process`: `${AI.on(Message)}` trigger + `AI.never` |
| Agent (member) | `Agent` term, interpolated into the channel charter |
| Agent responds | delegation tool (already compiled from `${Agent}` refs) |
| Two respond in parallel | spawn-and-continue (`background: true`) — already built |
| Early finisher informs the other | completion-steer (§2.8) — already built; needs a `steer_run` tool (small) |
| Thread | a **run** — world identity rides in `In` (thread id); already the run-identity doctrine |
| Human in the channel | the serving tier publishing onto the channel's `EventSource` + the Ask protocol for "channel asks human" |
| Message history | Trace projection — same "one log, many views" as ChatSessions |
| Org sidebar | **the term graph** — terms are pure data; topology is statically derivable |

The load-bearing observation: **the UI's structure is the Layer graph's
structure.** We never invented a config format for "what channels
exist" — interpolation already declares the hierarchy, and `refs` are
introspectable data.

## 2. The term model

```ts
// events
const ChannelMessage = AI.EventSource("org.message", S.Struct({
  channel: S.String, thread: S.optionalKey(S.String),
  author: S.String, text: S.String,
}));

// members
class Sage extends AI.Agent<Sage>()("Sage")`
You are the team's senior engineer. Thorough, terse. Use ${Grep} and
${ReadFile} before answering.` {}
class Scout extends AI.Agent<Scout>()("Scout")`
You are fast and breadth-first. Answer quickly, flag uncertainty.` {}

// a channel is a Process triggered by its messages, perpetual,
// whose charter simulates the room
class Engineering extends AI.Process<Engineering>()("engineering")`
You are the #engineering channel of a software team. Messages arrive;
you decide how the room responds — you never answer yourself.

Given a message: decide who would realistically respond (${Sage} for
depth, ${Scout} for speed — both in parallel when the question is both
urgent and deep). Open a thread for anything non-trivial. When one
responder finishes first, steer the other with what was found. Use
${PostMessage} to speak as the room (joins, status, summaries).
${AI.on(ChannelMessage)}
${AI.never`every message gets a response or an explicit pass`}` {}

// a group nests processes — same mechanism, one level up
class Helpdesk extends AI.Process<Helpdesk>()("helpdesk")`
You run the support side of the org: ${Support} for user questions,
escalating engineering-shaped problems to ${Engineering}.
${AI.on(ChannelMessage)}
${AI.never`no message unrouted`}` {}
```

The hierarchy **is** the interpolation graph: `Helpdesk → {Support,
Engineering}`, `Engineering → {Sage, Scout}`. The UI's sidebar is a
fold over `refs`.

## 2.5 User-defined Process kinds (`Channel` is not ours to ship)

The §2 sketch hides a wrong implication: that `Channel` is a primitive
we provide. The actual goal is stronger — **users define their own
process kinds**, customized for integration with their app, and
instantiate them like any term:

```ts
class General extends Channel<General>()("General")`
Casual chat for everyone. ${Sage} hangs out here.` {}
```

### The rule: a kind is a macro plus metadata — nothing else

A kind must never require kernel knowledge — otherwise every kernel
(memory, Cloudflare) needs code for every user kind and the extension
point is dead. And a kind must never *embed* an implementation — the
codebase's own law is contract-as-tag, implementation-as-Layer,
provided elsewhere. What survives those two constraints is small:

1. **Macro (term-level):** the kind *lowers* to a plain `Process`.
   Its charter scaffolding — the "you are a channel; simulate the
   room" prose, the standard refs (`${AI.on(ChannelMessage)}`,
   `${PostMessage}`, `${AI.never}`) — is spliced around the instance's
   template by **template composition** (templates are data: concat
   the strings arrays, concat the refs). The kernel sees an ordinary
   `Process` term; `InterpretableTerm` stays `Agent | Process`. The
   instance's tag resolves to plain `ProcessService`.
2. **Meta (topology-level):** the term carries `~alchemy/Subkind:
   "Channel"` (while `~alchemy/Kind` stays `"Process"`) plus a
   user-defined `meta` blob. `AI.topology` reports both, the serving
   tier passes them through untouched, and the app maps subkind →
   component/route. That is the whole "extend the DSL with their own
   interface" story for v1.

### Why NOT a service extension (`post`, `timeline`, …)

An earlier draft gave kinds a third slot: a decorator adding verbs to
the interpreted service (`ChannelService.post/timeline/threads`).
Tracing the actual consumers dissolved it:

| Flow | What actually implements it |
| --- | --- |
| human posts a message | `POST /api/channels/:id/messages` → serving tier → `EventBus.publish` → trigger wakes the ring (all existing, all generic) |
| timeline renders | `GET …/timeline` → serving tier projects `message.posted` Trace rows → SSE (the ChatSessions pattern, generic over a **row convention**) |
| an agent speaks | the `${PostMessage}` **Tool** — physics over the same seams |
| a charter references a channel | interpolation → delegation/steer tools → `ProcessService` (existing) |

No flow needs a kind-specific service verb. The real integration
points of a kind are its **event source** (ingress) and its **row
convention** (egress) — both already first-class. Embedding `service`
in the kind would have (a) conflated contract with implementation on
the definition, and (b) invented API for a consumer that doesn't
exist. If a domain later wants a typed client API (`generalChannel.
post(...)` from the user's own backend code), the standard pattern
already covers it: declare a companion `Context.Service` contract and
provide a Layer implemented over the seams — separately, like every
binding in this codebase. We add nothing until a real consumer demands
it.

### The constructor: `AI.Process` gets a dual interface

A kind is a *specialized Process constructor* — so the constructor of
kinds is `AI.Process` itself, with a second, config-taking form (the
base constructor is the trivial kind):

```ts
// instance of the base kind (unchanged, today's API)
class Fix extends AI.Process<Fix>()("Fix")`…` {}

// a KIND: name + definition instead of a template
const Channel = AI.Process("Channel", {
  // the macro: spliced around each instance's prose (${AI.body})
  charter: (name: string) => AI.charter`
You are the #${name} channel of the workspace. Messages arrive; you
decide how the room responds — you never answer yourself. ${AI.body}
Open a thread for anything non-trivial. Use ${PostMessage} to speak
as the room.
${AI.on(ChannelMessage)}
${AI.never`every message gets a response or an explicit pass`}`,

  // user-defined; flows through topology to the app untouched
  meta: { category: "channel", icon: "hash" },
});

// instances of the kind — same shape as any Process
class General extends Channel<General>()("General")`
Casual chat for everyone. ${Sage} hangs out here.` {}
```

The two call forms are unambiguous at runtime (second argument
present) and in the overloads (`AI.Process(name)` curries a template
taker; `AI.Process(name, definition)` returns a kind constructor).
Rejected names: `AI.ProcessKind` (clunky; and the dual interface says
the same thing structurally), `AI.Aspect` (connotes cross-cutting
concerns; these are domain nouns).

### Consequences worth writing down

- **`Group`, `Helpdesk`, and even our §2 `Engineering` become
  userland.** The org-chat example ships as *proof of the kind
  mechanism*, not as new primitives — `Channel` and `Group` are defined
  in the example, next to the app that consumes their meta.
- **Agent stays primitive (for now).** A kind sets control parameters
  through scaffold refs; Agent's specialization is *kernel policy*
  (the no-tool-calls halt is lore, not a ref), so it cannot be
  expressed as a kind today. If that ever changes, Agent collapsing
  into the kind form would be confirmation the abstraction is right.
- **Kinds nest into the ordinary type machinery**: `ProcessOut/In/Err`
  are derived from the *composed* refs, so a kind that scaffolds
  `AI.on(ChannelMessage)` gives every instance `In = Message` for
  free, and `AI.never` gives `Out = never`. The types teach the same
  lesson as the charter.
- **Two new mechanical utilities** fall out: `AI.charter` (template
  composition with a `${AI.body}` splice point) and the kind-form
  overload typing on `AI.Process`. Both are term-space, testable
  without a kernel.

## 2.6 Coordinator visibility (decided in v1)

A Process **never speaks in the room**. Users see only: member
messages (relayed via `post_reply`, rendered as authored bubbles),
delegation pills ("Sage is working…" — clickable, opening the run
inspector sidebar on that agent's ring), ask cards, and the one-line
resolution marker. The coordinator's prose and thinking are
suppressed in the channel UI (they remain fully visible in the
Trace/inspector — hidden is not deleted). Meta-questions about the
room itself are answered in the resolution summary, not as chat
prose. Agent work is asynchronous by construction: the pill is the
channel-side handle; the member's FINAL response is what lands in the
thread.

## 3. Primitive extensions (each small, each independently testable)

1. **`AI.topology(term)`** — a pure walk over a term's refs producing
   the org graph: `{ name, kind: "process" | "agent" | "tool" | "event",
   prose, children }`. Terms are data; this is a fold, no kernel
   involvement. Served as `GET /api/topology`. *(new file `Topology.ts`,
   ~80 lines + tests)*
2. **`steer_run` synthetic tool** — the missing verb for "one finished
   early, redirect the other." Delegation already registers background
   runs (`check_runs`/`wait_run`); `steer_run(runKey, message)` calls
   the child's `steer`. *(KernelMemory compileTools, ~30 lines + test)*
3. **Run-key addressing for threads** — a thread is a run whose world
   identity is the thread id. Concretely: `dispatch`/`send` items carry
   `{ thread: "t-123", … }`; the channel's charter opens threads by
   spawning runs with that identity; subsequent messages to the thread
   steer the SAME run (needs the Phase-2 "steer by run key" — currently
   steering addresses the active run only, fine at `concurrency 1`,
   incorrect under fan-out). *(the one genuinely new kernel behavior)*
4. **`PostMessage` tool + the message log** — messages are kernel
   facts. `PostMessage`'s physics appends a `message.posted` row to the
   poster's Trace (author = ring). The **channel timeline is a
   projection** across the channel ring's trace + its members' —
   exactly the ChatSessions pattern, keyed by channel/thread instead of
   conversation. The serving tier grows `ChannelView` next to
   `ChatSessions` (which stays, for plain chat apps). *(serving tier)*
5. **Human ingress** — `POST /api/channels/:id/messages` publishes onto
   the `ChannelMessage` EventSource via the EventBus (already exists);
   the channel ring wakes (already exists: the trigger runtime).
   Presence (“Sage is working…”) is derived from trace tails (already
   exists: the firehose).

Explicitly **not** built: per-term custom UI schemas ("extending the
DSL to include their own interface"). First version derives everything
from what terms already carry — name, kind, rendered prose, children.
If that proves insufficient, a `AI.ui({...})` ref is a term-level
attachment we can add later without churn; starting there would be
inventing config before we know what the UI actually needs.

## 4. The UI (evolving `examples/agent-chat-web` in place)

Same vendored component stack (chat-apps.md), new shell:

```
┌──────────┬──────────────────────────────┬─────────────┐
│ sidebar  │ #engineering                 │ thread pane │
│ (from    │  ├ msg (human)               │  (a run's   │
│ /api/    │  ├ Scout: quick answer       │   window —  │
│ topology)│  ├ 🧵 thread: "perf bug" ────│→  same part │
│ groups   │  ├ Sage is working… (live)   │   renderers)│
│ channels │  └ [ask card if parked]      │             │
│ members  │ [message composer]           │             │
└──────────┴──────────────────────────────┴─────────────┘
```

- Sidebar = `GET /api/topology` (statically derived org graph).
- Channel timeline = the channel's message projection (SSE window, same
  chunk protocol — messages are parts; the part renderers from
  chat-apps.md are reused wholesale).
- Thread pane = the run's window — literally today's chat view scoped
  to a run key.
- Presence = firehose-derived (ring busy / parked on ask / idle).
- The trace panel stays (per-ring engine room).

## 5. Research projects

- **R0 (kinds — the extension mechanism, §2.5):** template composition
  (`AI.charter` + `${AI.body}` splice), the dual-interface overload on
  `AI.Process` (composed-refs channel derivation; instances stay plain
  `Context.Service<Self, ProcessService>`), subkind + meta through
  topology. The org example is the proof: `Channel`/`Group` live in
  userland. **Open questions:** can a kind's scaffold refs be
  overridden per instance (probably no — scaffold is constitutional)?
  do kinds compose (a kind extending a kind — defer)? does the demo
  ever hit a wall that genuinely demands a typed client API beyond
  ingress-by-event + egress-by-row-convention (watch for it; don't
  pre-build it)?
- **R1 (topology):** the `AI.topology` fold; how groups render vs
  channels; whether membership (who's "in" a channel) is exactly the
  agent refs or needs joins.
- **R2 (threads as runs):** run-key steering under `AI.concurrency > 1`
  — the typed-steering design deferred from Phase 2 becomes load-bearing
  here. This is the riskiest piece; isolate it behind tests.
- **R3 (the room simulator):** prompt-engineering the Channel kind's
  scaffold — who-responds-first judgment, parallel dispatch discipline,
  steer etiquette ("relay the early answer, don't restart the slow
  run"). Lives in the KIND's charter (userland KernelPrompts-style
  colocation); OrgStress-style scripted test.
- **R4 (message semantics):** is a message a trigger event, a steer, or
  both? Proposal: new message in channel = trigger (new run) unless it
  addresses an open thread → steer of that run. The channel charter
  decides "addresses" (fuzzy), the kernel provides both verbs (exact) —
  the determinism line (§2.9) already draws this boundary.
- **R5 (hosting):** each ring a DO on the Cloudflare harness; the org
  boots from the same Layer graph. Nothing here changes the protocol —
  deferred until local works.

## 6. Build order

1. **R0 first — the kind mechanism** (`AI.charter`, the kind-form
   overload on `AI.Process`, subkind in topology), proven by a scripted
   test defining a toy kind. Everything downstream builds ON it; doing
   it later means rebuilding `Channel` twice.
2. `AI.topology` + `GET /api/topology` + sidebar (pure wins, no risk).
3. `PostMessage` + `message.posted` rows + `ChannelView` projection +
   channel timeline UI (the org becomes visible) — `Channel` defined in
   the example via `AI.kind`.
4. `steer_run` tool + completion-steer wiring in the Channel kind's
   scaffold (parallelism becomes coordinated).
5. Threads as run identity (R2 — the hard one, isolated behind tests).
6. The demo org (`#support`, `#engineering`, Helpdesk group as kind
   instances) + the room-simulator scaffold + an OrgStress-style live
   test.
7. Presence + polish; then hosting research (R5).
