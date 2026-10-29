---
name: pr-queue
description: Run a pull-request (or issue) queue for an area of alchemy — search GitHub for open PRs/issues matching a criteria (e.g. "cloudflare", "docker", "aws/rds", an author, a label), shortlist the top 10 ordered by ease of fixing, then fan each one out to its own T3 subagent thread (`delegate_task`, `isolation: "worktree"`) nested under this thread: each thread checks out, merges main, resolves conflicts, audits tests and JSDoc, runs the suites, rewrites the PR description as DX snippets, and stops with a merge-or-close recommendation, while this thread coordinates. Use for "start working on a pull request queue for cloudflare", "PR queue for docker", "triage open PRs for X", "work through the open fix(aws) PRs", "next PR" while a queue is running.
metadata:
  internal: true
---

# Pull request queue

This thread is the coordinator. Build the catalog once, then delegate one T3
**subagent thread** per PR or issue, each in its own worktree, and track them
from here. Each child fixes its item, pushes it, and ends with a
merge-or-close recommendation. The user merges; no thread ever does.

Children MUST be subagent threads started with `delegate_task`, never
top-level threads from `t3_thread_launch` or `create_threads`. Subagent
threads stay grouped under this thread in the sidebar and breadcrumb, and
this thread is notified when each one finishes. Detached top-level threads
lose both: the user can't tell which queue they belong to, and the
coordinator never hears back.

## 1. Build the catalog and shortlist

Turn the user's criteria into a search. An area like `docker` or `cloudflare`
matches conventional-commit scopes (`feat(docker)`, `fix(cloudflare/r2)!`) and
PRs that touch that provider's paths.

```sh
gh pr list --state open --limit 300 --json number,title,author,isDraft,mergeable,additions,deletions,changedFiles,updatedAt,isCrossRepository,maintainerCanModify,headRefName,baseRefName,url \
  > /tmp/pr-queue.json
# scope match: ^\w+!?\((<area>)(/[^)]*)?\)!?:   (case-insensitive)
# path match for anything the title missed:
gh pr view <n> --json files --jq '.files[].path' | grep -i '<Area>/'
```

For issues use `gh issue list --state open --search "<area> in:title,body"`.
Free-form criteria map onto `--author`, `--label`, `--search`. Leave out the
user's own PRs unless asked, and honor any exclusions they give (e.g. "ignore
the container PRs").

Print the **catalog**, grouped by theme when it's large:
`PR (link) | Author | Size | Behind main | What it does | Audit notes`, with
✅/❌ against the standards in
[audit/procedure.md §3](../audit/procedure.md#3-review-the-code). Annotate:

- **stacks** — a PR whose `baseRefName` is another PR's branch
  (`base #N ← child #M`)
- **overlaps** — PRs fixing the same issue or touching the same files; plan a
  merge order and which ones to close
- drafts, and PRs waiting on the author's answer to an earlier question

Then the **shortlist: top 10, easiest first** —
`# | PR (link) | Author | Size | Tests now | Likely work`. Rank by clean merge,
small diff, tests already in the right shape, single concern. Exclude drafts,
PRs waiting on the author, and forks we can't push to
(`maintainerCanModify: false`). PRs needing a test rewrite go on a separate
**rework list**. If fewer than 10 match, say it's the whole list.

Keep the shortlist as a status table with a thread link per row
(`[title](t3-thread://v1/<threadId>)`) and a status (`todo` / `ready → merge?` /
`close?` / `merged` / `closed` / `parked`), and re-print it whenever it changes.

## 2. Delegate one subagent thread per item

Call `orchestrator_capabilities` once, then start each item with
`delegate_task`:

```ts
delegate_task({
  title: "#<N> <short title>",
  role: "implementation",
  isolation: "worktree", // its own checkout, from this thread's commit
  mode: "async",         // never "wait": the coordinator keeps going
  task: "<contents of /tmp/pr-queue/brief-<N>.md>",
})
```

Keep each returned `taskId` and `childThreadId` in the status table. Delegate
the whole shortlist at once; there is no cap on running children. Send the
`delegate_task` calls in batches of about 3: each one cuts a worktree, and
cutting many at once in the same repo contends for git's locks. The worktree
is cut from this thread's commit, so keep the coordinator on an up-to-date `origin/main`; the brief checks out the PR
branch (or a new `fix/…` branch for an issue) itself.

A PR's brief starts with `/audit <N>`; an issue's says to fix it per
[audit/procedure.md](../audit/procedure.md) and open a PR ending in
`Fixes #<N>`. Every brief adds: `pnpm install` first, no subagents of its
own, one live suite at a time with `--concurrency 8`, `link_pull_request` on
every PR, no `watch_pull_request`, for features post the proposed API and
wait before building, and end with the line
`PR <url>, head <sha>, checks and reviews <state>` plus the recommendation.

If a child fails in preparation, `task_cancel` it and delegate a fresh one;
don't relaunch into the same branch by hand.

## 3. Coordinate

Don't do an item's work here, and don't poll children (`task_status`,
`sleep`, `t3_thread_wait`): T3 notifies this thread when a child finishes or
asks a question. Then `t3_thread_read` its `childThreadId`, update the table,
and relay its recommendation per
[audit/procedure.md §7](../audit/procedure.md#7-report-and-ask). Pass the
user's answers to a waiting child with `t3_thread_send` to its
`childThreadId`. A re-check or second review is a new `delegate_task`, not a
message to the old child. Stop a child the user parks or closes with
`task_cancel`. On "enqueue more", re-run the §1 search and delegate the next
batch.
