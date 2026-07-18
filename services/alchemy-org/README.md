# alchemy-org

A software factory that manages a GitHub repository end to end,
expressed almost entirely as prose: agents, the tools they hire, and
the typed parameters those tools speak. Code appears only at the
edges — tool physics and the seams (ledger, kernel, entrypoints) that
decide where the prose runs.

## The org

One file, one purpose:

- `src/repos.ts` — the managed repository; the resource IS the export
  (an un-yielded `GitHub.Repository` const; the Stack yields the same
  const to provision it).
- `src/vocabulary.ts` — the typed Parameters everything interpolates.
- `src/tools.ts` — the Tool contracts (pure terms; physics elsewhere).

The processes (`AI.Process<Self, Shape>`) — prose describing how work
moves, referencing the agents that do it. A process's tag resolves to
its declared deterministic interface ONLY; the actor verbs stay
private to its implementation Layer, which interprets the charter and
wires the world (events, schedules, substrate callbacks) to it:

- `src/issues.ts` — **Issues**: open → triage/dedupe/link → ready →
  hand to Engineer → close on merged evidence.
- `src/pull-requests.ts` — **PullRequests**: the org's ONE merge
  authority; every PR (factory's or human's) gets a Reviewer verdict,
  then merge or relayed changes.
- `src/discord.ts` — **FrontDesk**: the org's Discord front desk;
  mentions become answers, links to prior art, or well-formed issues
  — never work. Driven by the `Discord.ServerEventSource` seam (REST
  polling locally; gateway/webhook Layers slot in unchanged).
- `src/distilled.ts` — **Distilled**: the scheduled submodule
  maintainer; regenerate, test, PR through the same review door.

The agents (`AI.Agent<Self>`) — callable personas the processes
delegate to; every agent's tag is the same generic actor interface,
and `AI.layer(agent)` is the kernel-default implementation:

- `src/engineer.ts` — **Engineer**: one ready issue in, one PR out.
- `src/reviewer.ts` — **Reviewer**: diff against spec, approve or
  request changes; never saw the reasoning, on purpose.

Authority lives in reference topology, not configuration: only
PullRequests names `MergePullRequest`, only FrontDesk names `Reply`,
the Engineer never reviews and the Reviewer never edits. A capability
no charter mentions cannot be granted by any Layer.

## Physics and seams (code)

- `src/github-tools.ts` — tool physics over the `GitHub.*` API
  bindings (business rules like merge-needs-approval live here;
  missing bindings fail model-visibly with TODOs).
- `src/toolbox.ts` — the Engineer's local workspace physics
  (FileSystem / shell, sandboxed).
- `src/ledger.ts` — the dedupe/liveness seam (Memory | Sqlite | D1).
- `alchemy.run.ts` — the Stack: provisions the repository.

## What's next

The entrypoints that compose processes + physics per environment
(laptop polling / Cloudflare Worker webhook), the kernel
implementation that interprets the charters, and the Reply tool's
Discord physics. Git history holds the previous iteration.
