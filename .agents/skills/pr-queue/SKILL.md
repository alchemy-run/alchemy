---
name: pr-queue
description: Run a pull-request (or issue) queue for an area of alchemy — search GitHub for open PRs/issues matching a criteria (e.g. "cloudflare", "docker", "aws/rds", an author, a label), shortlist the top 10 ordered by ease of fixing, then fan each one out to its own T3 thread in its own worktree via the t3-code orchestrator: each thread checks out, merges main, resolves conflicts, audits tests and JSDoc, runs the suites, rewrites the PR description as DX snippets, and stops with a merge-or-close recommendation, while this thread coordinates. Use for "start working on a pull request queue for cloudflare", "PR queue for docker", "triage open PRs for X", "work through the open fix(aws) PRs", "next PR" while a queue is running.
metadata:
  internal: true
---

# Pull request queue

This thread is the coordinator. Build the catalog once, then launch one T3
thread per PR or issue, each in its own worktree, and track them from here.
Each thread fixes its item, pushes it, and ends with a merge-or-close
recommendation. The user merges; no thread ever does.

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

## 2. Launch one thread per item

Write each brief to `/tmp/pr-queue/brief-<N>.md` and launch it with
`t3_thread_launch` in its own worktree
(`{ type: "worktree", baseRef: "main", branch, startFromOrigin: true }`),
about 3 at a time. A PR's brief starts with `/audit <N>`; an issue's says to
fix it per [audit/procedure.md](../audit/procedure.md) and open a PR ending in
`Fixes #<N>`. Every brief adds: `pnpm install` first, no subagents, one live
suite at a time with `--concurrency 8`, `link_pull_request` on every PR, and
for features, post the proposed API and wait before building.

If a launch fails in preparation, don't retry it (the branch already exists):
launch a new thread on that worktree with `existing_worktree` and archive the
failed one.

## 3. Coordinate

Don't do an item's work here. When a thread finishes, read it, update the
table, and relay its recommendation per
[audit/procedure.md §7](../audit/procedure.md#7-report-and-ask). Pass the
user's answers to threads with `t3_thread_send`. On "enqueue more", re-run the
§1 search and launch the next batch.
