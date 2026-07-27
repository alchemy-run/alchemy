# alchemy-org

A software factory that manages a GitHub repository end to end,
expressed almost entirely as prose: agents whose charters splice the
tools they hire, the skills that teach craft, and the doors that
delegate work. Code appears only at the edges — routing, tool physics,
and the entrypoint composition that decides where the prose runs.

The folder structure is the architecture:

```
src/
  processes/   deterministic world-wiring (routers, sealed surfaces)
  agents/      who — the charters
  skills/      crafts — teachings + the tools they grant
  tools/       verbs — contract co-located with implementation Layers
  lib/         plumbing — patch engine, process runner, output store
  Server.ts    entrypoint — physics + composition + the web UI
```

## Processes (`src/processes/`)

Plain `Context.Service`s whose Layers consume the world and address
agents by key — routing is code, not charter:

- `Issues.ts` — the router: every repository event is addressed to
  the owner of the issue it concerns (`send(event, { key })`; the
  world closing the issue is `settle`). PR events reach the owner
  through the Ledger's recorded "Closes #N" link; unlinked PRs go to
  the standalone review desk.
- `PullRequests.ts` — the sealed read surface (list open PRs).
- `Discord.ts` — the Discord front desk; mentions become answers,
  links to prior art, or well-formed issues — never work.
- `Distilled.ts` — the scheduled submodule maintainer.

## Agents (`src/agents/`)

Bare `AI.Agent` tags; behavior lives on the `make` Layer as a charter
(init → stance). One run per world entity, keyed by it:

- `IssueOwner.ts` — owns one issue from open to close; its run is the
  issue's whole thread. It does no craft work: **doors**
  (`AI.Dispatch`) hand rounds to the Engineer and Reviewer with the
  task derived in policy code — and the child key IS the topology:
  both doors key their worker by the issue, so Engineer and Reviewer
  share one checkout. It merges (ratified against the approvals
  ledger), closes with citation, and covers author silence with a
  `remind_me` tool over the kernel clock.
- `Engineer.ts` — one round of issue work in, one pull request out.
  The `open_pull_request` wrapper calls `AI.reply(pr)` the moment the
  artifact exists, so the owner's dispatch resolves with the TYPED
  reference and the run parks — review feedback resumes the same
  engineer in the same worktree.
- `Reviewer.ts` — judges the artifact against the issue's acceptance
  criteria in the same checkout the change was built in; holds
  `Approve` but no merge. Also home to `PullRequestReviewer`, the
  standalone desk that reviews AND merges unlinked contributor PRs.
- `FrontDesk.ts` — the Discord desk's loop: mentions become
  answers, links to prior art, or well-formed issues — never work.
- `DistilledMaintainer.ts` — the scheduled submodule sync: regenerate,
  test, and PR through the same review door as everyone else.

Authority lives in reference topology, not configuration: only the
IssueOwner and the standalone desk name `MergePullRequest`, the
Engineer never reviews, and the Reviewer holds no editor. A capability
no charter mentions cannot be granted by any Layer.

## Skills (`src/skills/`)

Bare `AI.Skill` tags; the TEACHING (markdown prose + tool grants)
lives on the Layer. A skill is access at the type level, dormant until
the agent activates it; teachings reference deeper skills, forming a
graph the agent descends as the work demands:

- `Coding.ts` — the checkout craft (search/read/edit/patch/run + the
  discipline). References `ResourceEngineering` as the deeper craft.
- `ResourceEngineering.ts` — alchemy's resource doctrine (contract,
  reconciler, lifecycle edges); exposes `TypedErrors` and
  `LiveTesting`.
- `QualityAssurance.ts` — the Reviewer's craft: read and RUN, no
  editor — verification without authorship.

## Physics and seams (code)

- `src/tools/*.ts` — each tool's implementation Layer(s) live with
  its contract: GitHub-binding physics (business rules like
  merge-needs-approval), local Workspace physics (FileSystem/shell).
- `src/lib/` — `Patch.ts` (the apply-patch grammar: types, pure
  parser, guarded apply), `ProcessRunner.ts`, `ToolOutputStore.ts`,
  `Output.ts`.
- `src/Ledger.ts` — the dedupe/liveness + metadata seam
  (Memory | Sqlite | D1); PR→issue links live here.
- `src/Approvals.ts` — the two-key ceremony's ledger: the Reviewer
  records, the owner's merge ratifies.
- `src/Board.ts` — the domain projection over `AI.Chats` summaries
  that the UI renders (issues → owner thread → worker threads).
- `src/Server.ts` — the entrypoint: kernel + model, GitHub polling,
  `Git.WorkspacesWorktree` (one blobless clone, one worktree per run
  key) under `Workspace.perRun`, the skill graph composition per
  agent, and the HTTP surface (AI SDK UI protocol + the Vite-built
  SPA in `ui/`).
- `alchemy.run.ts` — the Stack: provisions the sandbox repository and
  runs the org server as a `Local.Service`.

## Running

```sh
doppler run -c dev --project alchemy-v2 -- bun alchemy deploy --yes
```

The deploy output prints the server URL; the UI lists open issues with
their owner threads, streams transcripts live (thinking traces, tool
calls, worker cards that link into dispatched threads), and accepts
messages that land as GitHub comments.
