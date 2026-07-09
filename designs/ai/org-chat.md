# Org Chat — the autonomous Discord/Slack

Status: **proposal** (July 2026). Builds on [serving.md](./serving.md)
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

- **R1 (topology):** the `AI.topology` fold; how groups render vs
  channels; whether membership (who's "in" a channel) is exactly the
  agent refs or needs joins.
- **R2 (threads as runs):** run-key steering under `AI.concurrency > 1`
  — the typed-steering design deferred from Phase 2 becomes load-bearing
  here. This is the riskiest piece; do it second, behind a test.
- **R3 (the room simulator):** prompt-engineering the Channel charter —
  who-responds-first judgment, parallel dispatch discipline, steer
  etiquette ("relay the early answer, don't restart the slow run").
  KernelPrompts-style colocation; OrgStress-style scripted test.
- **R4 (message semantics):** is a message a trigger event, a steer, or
  both? Proposal: new message in channel = trigger (new run) unless it
  addresses an open thread → steer of that run. The channel charter
  decides "addresses" (fuzzy), the kernel provides both verbs (exact) —
  the determinism line (§2.9) already draws this boundary.
- **R5 (hosting):** each ring a DO on the Cloudflare harness; the org
  boots from the same Layer graph. Nothing here changes the protocol —
  deferred until local works.

## 6. Build order

1. `AI.topology` + `GET /api/topology` + sidebar (pure wins, no risk).
2. `PostMessage` + `message.posted` rows + `ChannelView` projection +
   channel timeline UI (the org becomes visible).
3. `steer_run` tool + completion-steer wiring in the channel charter
   (parallelism becomes coordinated).
4. Threads as run identity (R2 — the hard one, isolated behind tests).
5. The demo org (`#support`, `#engineering`, Helpdesk group) + the room
   simulator charters + an OrgStress-style live test.
6. Presence + polish; then hosting research (R5).
