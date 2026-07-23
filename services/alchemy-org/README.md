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
- `src/tools/` — one file per tool: the contract co-located with its
  implementation Layer(s) (GitHub-binding physics, local Workspace
  physics, model-visible TODO stubs), same convention as alchemy's
  resources.
- `src/workspace.ts` — the Workspace service: WHICH checkout the
  local tool physics work in (the entrypoint's choice), with
  canonical path/symlink containment. Bash is trusted-host execution,
  not an OS sandbox.
- `src/coding.ts` — the **Coding** skill: the checkout craft
  (Grep/Glob/ListDirectory/ReadFile/EditFile/ApplyPatch/WriteFile/
  Bash/ReadOutput + the discipline for using them),
  referenced by Engineer and Distilled. Skills grant ACCESS at the
  type level but stay dormant until activated — or arrive
  pre-activated when a spawner hands them to a worker.
  Authority-bearing tools (merge, close, approve) are never bundled
  into skills: they stay direct splices, so the capability lines
  stay visible in prose.

The processes (`AI.Process<Self, Shape>`) — bare tags whose CHARTERS
(prose describing how work moves, referencing the agents that do it)
live with their implementation Layers and are passed to
`AI.actor(term, charter)`. A charter is init → turn: the init
effect runs once (allocate `AI.local` state, define inline tools);
the turn effect re-renders the stance before every sampling, so
prose, tools, and delegates can follow the run's state. A process's
tag resolves to its declared deterministic interface ONLY; the actor
verbs stay private to its implementation Layer, which interprets the
charter and wires the world (events, schedules, substrate callbacks)
to it:

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
and `AI.layer(agent, charter)` is the kernel-default implementation:

- `src/engineer.ts` — **Engineer**: one ready issue in, one PR out.
- `src/reviewer.ts` — **Reviewer**: diff against spec, approve or
  request changes; never saw the reasoning, on purpose.

Authority lives in reference topology, not configuration: only
PullRequests names `MergePullRequest`, only FrontDesk names `Reply`,
the Engineer never reviews and the Reviewer never edits. A capability
no charter mentions cannot be granted by any Layer.

## Physics and seams (code)

- `src/tools/*.ts` — each tool's implementation Layer(s) live with
  its contract: GitHub-binding physics (business rules like
  merge-needs-approval), local Workspace physics (FileSystem /
  shell), and model-visible TODO stubs where plumbing is
  pending.
- `src/internal/` — shared safe file operations, true-byte output
  truncation, scoped output artifacts, and process execution.
- `src/patch/` — strict Codex-style patch parser, matcher, virtual
  preflight planner, staged commit, and best-effort rollback.
- `src/ledger.ts` — the dedupe/liveness seam (Memory | Sqlite | D1).
- `alchemy.run.ts` — the Stack: provisions the repository.

## What's next

The entrypoints that compose processes + physics per environment
(laptop polling / Cloudflare Worker webhook), the kernel
implementation that interprets the charters, and the Reply tool's
Discord physics. Git history holds the previous iteration.
