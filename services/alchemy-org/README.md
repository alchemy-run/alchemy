# alchemy-org

The organization that maintains alchemy — the real alchemy-effect +
distilled flywheel, built on the same AI primitives the test fixture
(`packages/alchemy/test/AI/fixtures/org`) exercises against a contrived
sandbox repo.

## The flywheel

One GitHub issue, one run, owned end to end. The Process itself
triages, replies, and merges (SearchIssues / Comment / MergePullRequest
are its tools); agents exist only where the work is a distinct craft:

1. **Issue opens** (`GitHub.IssueOpened(alchemyEffect)`) — the Process
   dedupes it, answers questions, or writes acceptance criteria.
2. **Engineer** works in one workspace: the alchemy-effect checkout with
   the distilled submodule embedded at `./distilled`. A fix that spans
   both repositories is one change — the distilled PR first, then the
   superproject PR that bumps the submodule pointer.
3. **Reviewer** reviews every PR the issue produced as one change — a
   spanning pair lands together or not at all. Approval belongs to the
   Reviewer alone (the autonomy dial).
4. **Merge** via `MergePullRequest` (refuses without an approved
   review), distilled-first. GitHub closing the issue ends the work
   (`AI.until(GitHub.IssueClosed(alchemyEffect), …)`) — the world, never
   the model's claim.

## Layout

- `src/repos.ts` — the resources ARE the exports (un-yielded
  `GitHub.Repository` consts; charters use them deferred, the Stack
  yields them).
- `src/vocabulary.ts` / `src/tools.ts` — typed Parameters + Tool
  contracts.
- `src/agents.ts` — Engineer / Reviewer.
- `src/flywheel.ts` — the `ResolveGitHubIssue` process + org-internal
  sources.
- `src/worker.ts` — the deployable Worker shape (derived front door).
- `alchemy.run.ts` — the Stack entry.

## Status: NOT deployed

Tool physics in `src/layers.ts` are `Layer.succeed(...)` stubs — wire a
DevBox container, Octokit, and an approval surface before deploying.
The kernel Layer in `src/worker.ts` is an in-memory placeholder; the
durable Cloudflare kernel replaces it at deploy time. When ready:
`bun alchemy deploy` provisions the repos and their webhooks.
