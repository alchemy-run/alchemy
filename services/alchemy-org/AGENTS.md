<!-- GENERATED from src/Harness.ts by `bun scripts/agents-md.ts` — edit the
     teaching there, not this file. The org's agents activate the same text
     as the `Harness` skill. -->

# Working on alchemy-org — the harness

`services/alchemy-org` is the software factory that maintains the
alchemy repository: coding and review agents whose charters are
prose, running over sandboxes that hold a checkout, proposing every
GitHub write to an operator. It lives INSIDE the repository it
maintains, so a change here changes the hands that make the next
change. The lift runs in three stages — a human coding agent
(Cursor) editing this folder; `alchemy dev` running the org on
the developer's machine (sessions in git worktrees, GitHub by
polling); `alchemy deploy` running it live (sessions in microVMs,
GitHub by webhook). Every stage is held to the rules below. The
repository's root `AGENTS.md` applies in full (Effect-only code,
typed errors, no `async`/`await`, no raw `node:fs` in resource
code); this file adds the org's own.

## The layout is the architecture

`src/` is organized by DOMAIN — what a file acts on — never by kind.
There is no `tools/`, `agents/`, `skills/`, or `lib/`, and no
barrel `index.ts`: import the file.

- `coding/` — the Engineer: its charter (`Engineer.ts`), the
  toolbox (`Toolbox.ts` grouping `Bash`, `ReadFile`, `Grep`,
  `Glob`, `ListDirectory`, `ReadOutput` as Read + Run), the
  editor (`Editor.ts` — `EditFile` + `WriteFile`, the ONLY layer
  that grants a write), and `Publish.ts` (push a branch, propose a
  pull request).
- `review/` — the Reviewer: its charter, `ReviewerEvents.ts` (the
  GitHub event router), `PullRequests.ts` (the rubric every PR is
  held to, spliced into BOTH charters), `Companions.ts`,
  `ReadDiff.ts`, `ReadIssue.ts`, `QualityAssurance.ts`, and the
  `Ledger`.
- `sandbox/` — where code runs: `SandboxSession.ts` picks a
  session's machine; `SandboxMicrovm.ts`, `SandboxContainer.ts`,
  `SandboxWorktree.ts` are its variants; `CheckoutsSandbox.ts` /
  `CheckoutsWorktree.ts` implement `Git.Checkouts` over each;
  `SessionRepo.ts` resolves which tree a session holds;
  `SpillingTools.ts` + `Artifacts*` + `ReadOutput.ts` are the
  output spill every tool runs through.
- `github/` — the connected repositories (`Repos.ts`), the
  proposals gate (`Proposals.ts`, `ProposalsD1`, `ProposalsMemory`,
  `ProposalActions.ts`), and the UI projections (`Board.ts`,
  `PullRequest.ts`).
- `platform/` — Cloudflare seams: `DriverCloudflare.ts` (sessions
  as Durable Objects), `Database.ts`, `SessionIndexD1.ts`,
  `Model.ts`.
- `Routes.ts` is the HTTP API the UI speaks; `Worker.ts` composes
  everything onto Cloudflare; `Harness.ts` is this doctrine.

Names carry the convention: a variant family keeps its prefix
(`Sandbox*`, `Checkouts*`, `Artifacts*`); an implementation Layer
is `*Live` (or `*General` for a teaching, `*D1` / `*Memory` for a
store). A tool's contract and its `*Live` Layer live in ONE file; a
parameter lives with its canonical tool and is imported from there
(`path` from `ReadFile.ts`, `content` from `WriteFile.ts`), never
redeclared. When a file moves, move it with `git mv`, rewrite the
imports, and rewrite the PROSE that names its path — doc comments,
the README, this teaching; a stale path in a comment is a bug.

## Prose is code

An agent is a bare `AI.Agent` tag; its behavior is a charter Layer:
INIT runs once per session (mint tools, resolve the tree) and returns
the STANCE, a fragment re-rendered before every sampling. A skill is
a bare `AI.Skill` tag whose teaching rides its Layer, dormant until
the agent activates it. A tool's tagged template is its description
and the `AI.Parameter`s it splices are its schema. Shared doctrine
is an `AI.fragment` spliced into several stances.

Mention is presence: a charter's toolkit is exactly what its prose
splices, and every splice charges the Layer's requirement channel, so
capability is a type-level fact. Authority therefore lives in
reference topology, not configuration: the editor is granted by
`coding/Editor.ts` alone and the Reviewer's Layer graph never
includes it; no charter names a merge tool — merging is the
operator's click. Never widen a stance to "make something work";
if a capability must be granted, grant it where the domain says so
and make the grant visible in the Layer graph.

`test/wire.types.ts` pins each charter's wire (`AI.ToolNames` /
`AI.ToolInput`) and `ui/components/tool-card.tsx` renders each tool
by name. A new tool on a stance is three edits: the tool file, the
wire list, the renderer — the type-check tells you which you missed.

## Tool physics

Every tool runs over the session's `AI.Sandbox` — the machine that
holds the checkout — never the Worker's own filesystem. Tools return
their failures to the model (`Effect.fail(text)` is a model-visible
result, not a crash). Output is bounded: `bash` truncates, the spill
net parks oversized results in `Artifacts`, and `readOutput`
pages them back — never print unbounded output into the transcript.
Search physics are deterministic (ripgrep semantics honoring the
repository's ignores) so a test can assert them.

## Sandboxes and checkouts

A session's key names its tree: `owner/repo/name` works in the
repository's default branch; `owner/repo#N` works in pull request
N's head, checked out ON that branch (a fork's head is read-only at
`pull/N/head`). `SessionRepo` resolves the tree; the checkout itself
lands the first time a tool touches the machine. Under `alchemy dev`
the machine is a git worktree under `.alchemy/worktrees` created by
`scripts/worktree.ts`, and distilled is a worktree of the SHARED
submodule repository (`.git/modules/distilled`) — never run
`git submodule update` inside a linked worktree: it repoints the
shared module's `core.worktree` and breaks the root checkout.
Deployed, the machine is a microVM booted from the image
`SandboxBake.ts` bakes with the repository installed and compiled.

## GitHub is behind the proposals gate

No agent writes to GitHub. A review, a comment, a merge, a pull
request is a PROPOSAL (`github/Proposals.ts`) the operator accepts,
declines, or sends back for changes in the UI; `ProposalActions.ts`
performs the write on accept. A pending proposal is a living draft —
the proposing agent revises it in place (`Proposals.revise`) when
the code moves or the operator asks. Events arrive through
`GitHub.consumeRepositoryEvents` (a webhook deployed, polling in
dev), deduped by the Ledger; `ReviewerEvents.ts` routes them: a PR
opening starts its review, every push wakes the same session to
revise it, close or merge settles it and withdraws its proposals.
A new GitHub write is a new proposal kind, never a direct call.

## Tests

Every behavior change ships with its test — the rubric in
`review/PullRequests.ts` applies to this service as to any other.

- `bun test` (`test/`) — the physics: tools over a real
  `SandboxLocal` in a temp directory, the ledger, the spill net.
  Real processes, real files; the only fake is the model
  (`test/fixtures/ScriptedModel.ts`), never the sandbox.
- `test/wire.types.ts` — compiled, never run; fails `tsc` when a
  wire regresses.
- `pnpm test:e2e --project ui` — Playwright against the SPA over
  the in-page fake API (`e2e/ui/harness.ts`) with a fixed clock:
  the UX contract, byte-stable aria snapshots and a screenshot
  gallery. After a deliberate UX change, `pnpm test:e2e:update`
  re-blesses them — and you LOOK at what changed before you commit.
- `pnpm test:e2e:live` — the same SPA against a running
  `alchemy dev` (real GitHub, a real shell behind the terminal).

## Done means verified

Before you call a change finished, from the repository root:
`pnpm exec tsc -b services/alchemy-org` is clean; `bun test` and
`pnpm test:e2e --project ui` pass in `services/alchemy-org`; and
`bun scripts/agents-md.ts --check` confirms `AGENTS.md` matches this
teaching. Explore before you conclude — `grep` for content, `glob`
for files, `listDirectory` for shape, `readFile` in whole regions —
and verify by RUNNING with `bash`, never by reading alone.
`Worker.ts` and `Routes.ts` are touched by every change to the
system: make single minimal insertions there, never a rewrite.

## Changing this doctrine

This teaching is the one source. Edit `src/Harness.ts`, run
`bun scripts/agents-md.ts` to regenerate `AGENTS.md`, and commit
both; the test fails when they drift. The org's agents activate
`Harness` when their work touches this folder, so what you write
here is what they will do next.
