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

## 2. Write one brief per item

A thread knows only its first message. Write each brief to
`/tmp/pr-queue/brief-<N>.md` and launch the thread with a one-line message
pointing at it (`cat /tmp/pr-queue/brief-<N>.md` and follow it). The brief
carries:

- **The item:** number, title, URL. For a PR, the message starts with
  `/audit <N>` and the thread runs `gh pr checkout <N>` in its worktree. For an
  issue, the thread checks whether main or an existing PR already covers it
  (close with a citation if so), otherwise fixes it on its branch and opens a
  PR ending in `Fixes #<N>`.
- **Setup:** `git submodule update --init -- submodules/distilled` and
  `pnpm install` in the fresh worktree. Never `git stash`.
- **The standards:** [audit/procedure.md](../audit/procedure.md) §3–§7 —
  regression test in the existing suite, end to end, proven to fail on main;
  JSDoc; DX-snippet PR description via `--body-file`.
- **Shared-machine limits:** no subagents or workflows; one live suite at a
  time with `--concurrency 8`; no `tsrs -b` except once at the end if types
  changed. Auth failing within ~100ms means expired AWS SSO — stop and say so.
- **Linking:** call `link_pull_request` for every PR it opens or works on.
- **Design-heavy items** (features, new APIs): post the proposed user-facing
  API as whole runnable snippets in the thread and wait for an answer before
  building.
- **The final reply:** PR link, tests run with pass/fail and whether the new
  case fails on main, design questions, merge-or-close recommendation.

## 3. Launch threads without branch clashes

Launch with `t3_thread_launch` and
`workspaceStrategy: { type: "worktree", baseRef: "main", branch, startFromOrigin: true }`
(`fix/<area>-issue-<N>` for issues, `audit/pr-<N>` for PRs). The branch name
is the thread's identity, so guard it:

- **Check before launching.** `git rev-parse --verify --quiet refs/heads/<branch>`
  and `git worktree list --porcelain | grep "refs/heads/<branch>$"`. If the
  branch exists from an earlier run, reuse its worktree via
  `{ type: "existing_worktree", worktreePath, branch }`, or pick a new name —
  never launch a `worktree` strategy onto an existing branch.
- **Launch at most 3 at a time.** Ten parallel checkouts of this repo take
  long enough that T3 reports `git worktree add failed` after ~55s even though
  git goes on to create the branch and worktree. Wait until the batch leaves
  `preparing` (`t3_thread_list`) before launching the next.
- **When preparation fails,** never retry that thread: its retry runs
  `git worktree add -b` again and fails with `branch_already_exists`. Instead:
  1. Look for the worktree git made anyway (`git worktree list --porcelain`).
  2. If it exists and is clean, launch a new thread on it with
     `existing_worktree`; otherwise delete the branch (only if
     `git rev-list --count origin/main..<branch>` is 0) and launch fresh.
  3. Archive the failed thread immediately (`t3_thread_organize`,
     `action: "archive"`), so no thread is left claiming a branch another
     thread owns.

## 4. Coordinate

- Don't do an item's work in this thread. Read a thread's result with
  `t3_thread_read` when it completes, update the status table, and relay its
  recommendation in the [audit/procedure.md §7](../audit/procedure.md#7-report-and-ask)
  shape, one PR per message, ending with the PR's full URL.
- Answer a thread's design question by sending it the user's decision with
  `t3_thread_send`.
- On "merged", verify with `gh pr view <n> --json state`; tell the threads
  whose PRs touch the same files to re-merge main.
- On "close" or "park", update the table and tell the thread. Close only on
  explicit instruction, with a comment crediting the author and naming what
  supersedes it.
- On "enqueue more", re-run the §1 search, skip items already queued or
  excluded, and launch the next batch per §3.
