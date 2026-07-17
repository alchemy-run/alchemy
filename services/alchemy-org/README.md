# alchemy-org

A software factory that manages a GitHub repository's issues and pull
requests end to end — two AI processes, two agents, one budget —
written ONCE against seams (arrival, ledger, kernel, tools) and run in
any environment by swapping Layers.

It currently manages the `test-alchemy` SANDBOX repository (a repo we
own and can reset). Pointing it at the real alchemy repositories is a
one-line change in `src/repos.ts` once the loop has proven itself.

## The flywheel

One GitHub issue, one run, owned end to end. The Process itself
triages, replies, and merges (SearchIssues / Comment / MergePullRequest
are its tools); agents exist only where the work is a distinct craft:

1. **Issue opens** (`GitHub.IssueOpened(testAlchemy)`) — the
   `GitHubIssues` process dedupes it, answers questions, or writes
   acceptance criteria.
2. **Engineer** works the checkout until the tests are green and opens
   a pull request.
3. **Reviewer** reviews the PR against the issue; approval belongs to
   the Reviewer alone (the autonomy dial).
4. **Merge** via `MergePullRequest` (refuses without an approved
   review). GitHub closing the issue settles the run
   (`AI.exit(AI.when(GitHub.IssueClosed(testAlchemy)))`) — the world,
   never the model's claim.

`GitHubPullRequests` shepherds each PR the same way (opened → reviewed
→ merged).

## Layout

- `src/repos.ts` — the resource IS the export (the un-yielded
  `GitHub.Repository` const); charters, bindings, and the Stack all
  name the repository through it.
- `src/vocabulary.ts` / `src/tools.ts` — typed Parameters + Tool
  contracts.
- `src/agents.ts` — Engineer / Reviewer.
- `src/issues.ts` / `src/pull-requests.ts` — the two processes: charter
  (the interface) + ONE generic implementation Layer each (delivery,
  ledger dedupe, domain methods over the `GitHub.*` API bindings).
- `src/ledger.ts` — the dedupe/liveness seam (Memory | Sqlite | D1).
- `src/github-tools.ts` — tool physics over the GitHub API bindings
  (business rules like merge-needs-approval live here).
- `src/toolbox.ts` — the Engineer's local workspace physics.
- `src/factory.ts` — both processes under one budget,
  environment-agnostic.
- `src/local.ts` — the factory on a laptop (polling, sqlite ledger,
  in-process kernel): `bun run src/local.ts`.
- `src/worker.ts` — the factory on Cloudflare (webhook, D1 ledger).
- `alchemy.run.ts` — the Stack: provisions the managed repository and
  the OrgWorker; the Worker's Layers declare their own infrastructure
  (webhook, D1) as a consequence of consuming it.

## Run it locally

```sh
ANTHROPIC_API_KEY=… GITHUB_TOKEN=… bun run src/local.ts
```

Optional: `FACTORY_WORKSPACE` points at the Engineer's checkout
(defaults to `.factory-workspace`).

## Deploy status: shape complete, kernel TODO

`bun alchemy deploy` provisions the repository, the webhook, the D1
ledger, and the Worker. Two TODO(deploy) slots remain stubbed in
`src/worker.ts`: the kernel (model turns must move into the OrgRing
Durable Object — `AI.memory` in a stateless Worker is a placeholder)
and the Engineer's workspace tools (the DevBox container).
