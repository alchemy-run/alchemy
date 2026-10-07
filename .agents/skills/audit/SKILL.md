---
name: audit
description: Audit one or more specific pull requests the user names — PR numbers, `#N`, or GitHub URLs (e.g. "/audit 2101", "/audit #2101 #2093 #2088", "/audit https://github.com/alchemy-run/alchemy/pull/2101"). Runs the pr-queue audit on each one in turn: check out, merge main, resolve conflicts, audit tests and JSDoc, run the suites, rewrite the description as DX snippets, push, and stop with a merge-or-close recommendation. Use instead of pr-queue when the user hands you the PRs rather than a search criteria; also for "also audit #N" or "next" while an audit list is running.
---

# Audit a list of pull requests

The user hands you the PRs. There is no search and no shortlist: the list is
the queue. Everything else is the pr-queue process — read
[`../pr-queue/SKILL.md`](../pr-queue/SKILL.md) now and follow §2–§8 for each
PR. This file only covers what differs.

## 1. Parse the list

Accept any mix of `2101`, `#2101`, and PR URLs, separated by spaces, commas or
newlines. Dedupe. A URL for another repository (e.g.
`alchemy-run/distilled`) is audited with `-R <owner>/<repo>` on every `gh`
call and in that repository's checkout (`submodules/distilled`).

Fetch each one:

```sh
gh pr view <n> --json number,title,author,state,isDraft,mergeable,additions,deletions,changedFiles,isCrossRepository,maintainerCanModify,headRefName,baseRefName,url
```

Say so up front, and leave it out of the table, when a PR is already merged or
closed, or doesn't exist. A draft or a fork we can't push to
(`maintainerCanModify: false`) stays in the list — the user asked for it — but
note that fixes there go to the author as a comment or a follow-up PR.

## 2. One PR

Skip the table. Go straight to pr-queue §2 (check out and merge main) and end
with the §7 report.

## 3. Several PRs

Order them before starting:

- **stacks first** — a PR whose `baseRefName` is another listed PR's branch
  goes after its base (`base #N ← child #M`)
- **overlaps** — PRs fixing the same issue or touching the same files: plan a
  merge order and flag any that the other supersedes
- otherwise keep the user's order; if they gave none, easiest first (clean
  merge, small diff, tests already in the right shape)

Print the status table once, then re-print it whenever it changes:

`# | PR (link) | Author | Size | Status | Notes`

Status is `todo` / `in progress` / `ready → merge?` / `close?` / `merged` /
`closed` / `parked`.

Then take them one at a time through pr-queue §2–§7. End the turn after each
PR with its §7 report, naming the next one (`Next: #M`). If an audit finds a
problem shared by several listed PRs (e.g. the same faked suite), fix it once
in its own PR off main and say which listed PRs it unblocks.

## 4. Changing the list mid-session

- "also audit #N" — append it to the table (respecting stacks/overlaps) and
  keep going with the current PR.
- "drop #N" / "skip #N" — mark it and move on.
- "next" — continue with the next `todo`; on "merged, next" check it really
  merged before re-merging main into the next one (pr-queue §8).
- When every PR is `merged`, `closed` or `parked`, print the final table and
  stop. Don't go searching for more PRs — that's pr-queue.
