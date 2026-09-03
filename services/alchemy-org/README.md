# alchemy-org

A software factory that manages a GitHub repository end to end,
expressed almost entirely as prose: agents whose charters splice the
tools they hire and the skills that teach craft. Code appears only at
the edges — event routing, tool physics, and the entrypoint composition
that decides where the prose runs.

The folder structure is the architecture — `src/` is organized by
DOMAIN, not by kind (there is no `tools/`, `agents/`, or `skills/`
folder; a tool lives with the domain it acts on):

```
src/
  coding/    the Engineer: charter, the toolbox (read/run/edit tools), publishing a PR
  review/    the Reviewer: charter, event router, review tools, rubric
  sandbox/   where code runs: sessions' sandboxes, checkouts, output spill
  github/    the connected repositories, proposals, board projection
  platform/  Cloudflare seams: D1, model, driver
  Routes.ts  the HTTP API the UI speaks
  Worker.ts  entrypoint — composition of the above onto Cloudflare
  Harness.ts the org's own doctrine — a skill the agents activate,
             rendered to AGENTS.md for human coding agents
```

The conventions for working on this folder live in [AGENTS.md](./AGENTS.md)
— generated from `src/Harness.ts` by `bun scripts/agents-md.ts`, the same
text the Engineer and Reviewer activate as the `Harness` skill.

## Agents

Bare `AI.Agent` tags; behavior lives on the `*Live` Layer as a charter
(init → stance). One session per world entity, keyed by it.

- `coding/Engineer.ts` — the coding agent: the toolbox
  (`coding/Toolbox.ts` — `Bash`, `ReadFile`, `Grep`, `Glob`,
  `ListDirectory`, `ReadOutput`, grouped as Read + Run) plus the
  editor (`coding/Editor.ts` — the ONLY layer that grants
  `EditFile`/`WriteFile`), and `coding/Publish.ts` to propose a pull
  request. Its stance splices `review/PullRequests.ts` so it builds
  what the Reviewer will judge.
- `review/Reviewer.ts` — the review agent: reads and RUNS in the PR's
  checkout, never edits. It drafts a review as a PROPOSAL and keeps it
  a living draft: every new commit revises it in place, and the
  operator accepts, declines, or asks for changes from the UI until
  the review posts or the PR closes.

Authority lives in reference topology, not configuration: the Engineer
never reviews, the Reviewer holds no editor, and nothing reaches
GitHub without a proposal the operator accepted. A capability no
charter mentions cannot be granted by any Layer.

## The review pipeline (`src/review/`)

- `ReviewerEvents.ts` — the router. `PullRequestOpened` starts the
  review; `PullRequestSynchronized` (a new head commit) wakes the
  same session to revise it; PR comments (not the bot's own) are
  forwarded; close/merge settles the session, withdraws its pending
  proposals, and releases its checkout. Deliveries are deduped through
  the Ledger and verified with `GITHUB_WEBHOOK_SECRET` when set.
- `PullRequests.ts` — the rubric (an `AI.fragment`): behavior ships
  with its tests, tests are end-to-end fixtures (no mocks, idempotent,
  cover the variants), DX-first descriptions with a verification
  report, a companion PR in `distilled` with the submodule pin
  checked, an emulation in `floci` for AWS providers.
- `Companions.ts` — `findCompanions`: the companion pull requests
  (same branch name) in `distilled`/`floci`, and the submodule path
  whose pin to compare.
- `ReadDiff.ts` / `ReadIssue.ts` — the PR and issue read surfaces.
- `QualityAssurance.ts` — the Reviewer's craft skill.
- `Ledger.ts` (+ `LedgerD1` / `LedgerMemory`) — dedupe, liveness, and
  metadata.

## Proposals (`src/github/`)

Agents never act on GitHub directly. `Proposals.ts` is the
human-in-the-loop gate: a review, a comment, a merge, or a new pull
request is recorded as a pending proposal (`ProposalsD1` in prod,
`ProposalsMemory` in tests) and `ProposalActions.ts` replays it
verbatim once the operator accepts. `revise` lets the proposing agent
update a pending proposal in place; `POST /api/proposals/:id/revise`
carries the operator's "ask for changes" back to it.

`Repos.ts` names the connected repositories (`primary`, the companions
`distilled` and `floci` with their submodule paths, publish targets);
`Board.ts` and `PullRequest.ts` project sessions and pull requests for
the UI.

## Sandboxes (`src/sandbox/`)

Every session's tools run in a sandbox that holds a checkout of the
repository it works on:

- `SandboxSession.ts` picks the sandbox for a session; `SessionRepo.ts`
  resolves which tree (a PR's head, a branch) it should hold.
- `SandboxMicrovm.ts` — a Firecracker microVM per machine, the org
  image baked by `SandboxBake.ts`; `SandboxContainer.ts` — the
  Cloudflare Container variant; `SandboxWorktree.ts` — `alchemy dev`,
  a git worktree under `.alchemy/worktrees` on the host.
- `CheckoutsSandbox.ts` / `CheckoutsWorktree.ts` — `Git.Checkouts`
  implementations for each.
- `SpillingTools.ts` — the spill net over every tool: oversized
  output lands in `Artifacts` (`ArtifactsLocal` / `ArtifactsSandbox`)
  and `ReadOutput.ts` pages it back.

## Platform (`src/platform/`)

`DriverCloudflare.ts` binds sessions to Durable Objects,
`Database.ts` / `SessionIndexD1.ts` keep the board and session index
on D1, `Model.ts` selects the model.

## Running

```sh
bun alchemy dev      # local: sessions in worktrees, GitHub by polling
bun alchemy deploy   # Cloudflare: microVMs, D1, GitHub by webhook
```

The deploy output prints the site URL; the UI is a coding-agent chat —
each new session gets its own sandbox, streams its transcript live over
the session socket, and pending proposals show in the inbox and on
their pull request.
