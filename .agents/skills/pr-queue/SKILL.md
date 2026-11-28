---
name: pr-queue
description: Run a pull-request (or issue) queue for an area of alchemy — search GitHub for open PRs/issues matching a criteria (e.g. "cloudflare", "docker", "aws/rds", an author, a label), then present every match as a DX card (one small code snippet of the developer experience it adds, changes or removes, grouped by theme) so the user decides take / reshape / decline per item without reading PR bodies. Work the items the user takes one at a time in this thread; launch detached top-level T3 threads (`t3_thread_launch`) only when the user asks for them. Use for "start working on a pull request queue for cloudflare", "PR queue for docker", "triage open PRs for X", "work through the open fix(aws) PRs", "next PR" while a queue is running.
metadata:
  internal: true
---

# Pull request queue

The user judges pull requests and issues by the **developer experience** they
propose: what code a user newly writes, what code changes, and what goes away.
Show every item as a short code snippet of that change, so the user can decide
on all of them without reading a single PR body. Do no work on an item until
the user has decided on it.

## 1. Search

Turn the user's criteria into a search. An area like `docker` or `cloudflare`
matches conventional-commit scopes (`feat(docker)`, `fix(cloudflare/r2)!`) and
PRs that touch that provider's paths.

```sh
gh pr list --state open --limit 300 --json number,title,author,isDraft,mergeable,additions,deletions,changedFiles,updatedAt,isCrossRepository,maintainerCanModify,headRefName,baseRefName,url \
  > /tmp/pr-queue.json
# scope match: ^\w+!?\((<area>)(/[^)]*)?\)!?:   (case-insensitive)
# path match for anything the title missed:
gh pr view <n> --json files --jq '.files[].path' | grep -i '<Area>/'
# bodies and checks, for the cards
gh pr view <n> --json body,files,statusCheckRollup > /tmp/pr-queue/<n>.json
```

For issues use `gh issue list --state open --search "<area> in:title,body"`.
Free-form criteria map onto `--author`, `--label` and `--search`. Leave out the
user's own PRs unless asked, and honor any exclusions they give ("ignore Sam's
PRs", "ignore the container PRs").

Read each body for its code blocks, and the diff when the body has none. Note
the facts that change a decision: draft, merge conflicts, failing CI, a fork we
can't push to (`maintainerCanModify: false`), a stack (`baseRefName` is another
PR's branch), and overlaps (PRs on the same issue or the same concept).

## 2. Present DX cards

Print one card per item, grouped under `##` theme headings (reads, storage,
failures, deployment, new packages …). A card looks like this:

````md
**[#3810](https://github.com/<owner>/<repo>/pull/3810) — a reused command id with another input fails (breaking)**
```ts
yield* api.Increment({ counterId, amount: 1 }, { commandId: "s:0" }); // first receipt again
yield* api.Increment({ counterId, amount: 5 }, { commandId: "s:0" }); // CommandIdReused   before: silently dropped
```
````

Rules:

- **The snippet is the user's code**, not the implementation: the call, the
  option, the Layer, the declaration. Put the effect in trailing comments:
  `// new result   before: old result`.
- **Three to six lines.** Trim the PR's own snippet and drop setup every reader
  knows. Never a wall of code, never two columns side by side.
- **Show removals and breakage.** A removed or renamed API gets a ` ```diff `.
  A behavior change with no type change says so in a comment (`// cost: …`).
- **No snippet in the PR?** Write one from the description or the diff, and
  label invented values (`// both values here are placeholders I wrote`). A
  change with no user-facing surface (an internal fix) says so in a one-line
  comment in the block.
- **The title line carries the facts**: draft, conflicts, failing CI, a fork we
  can't push to, size when it's large, and how it relates to another item
  (`builds on #3809`, `overlaps #3696`). Add at most one line of prose, only
  when a fact needs explaining.
- **Flag house-rule breaks** in the snippet's comments (raw `await`, `Input<T>`
  in props, a three-segment API path).
- Within a theme, order the cards in merge order when one item builds on
  another.

End with **Decisions for you**: each item is take / reshape / decline, then
list only the calls that need judgement: overlapping items (pick one, or
both), changed defaults, and the large ones (take, park or decline). Print no
metadata tables, shortlists or plans before the user has decided.

## 3. Work the items the user takes

Work starts only after the user decides, and by default it happens in this
thread:

- One item at a time, in merge order. Check each one out in its own worktree
  under `.alchemy/worktrees/pr-<N>` and run
  [`/audit <N>`](../audit/procedure.md) there. Fix an issue per the same
  procedure, in a PR ending in `Fixes #<N>`. Apply any reshape the user asked
  for on the card.
- One live suite at a time, with `--concurrency 8`. Use no subagents unless
  the user allows them; when they do, run at most 3, still with one live suite
  at a time.
- Call `link_pull_request` on every PR and `watch_pull_request` after each
  push, and leave every CI check passing on the final head
  ([audit/procedure.md §6](../audit/procedure.md#6-push-and-update-the-pr)).
- Bring the user **one merge-ready item per message**
  ([audit/procedure.md §7](../audit/procedure.md#7-report-and-ask)). After a
  merge, rebase the next items onto main before continuing.
- Close declined items yourself, with a short comment saying why.

## 4. Detached threads, only when asked

When the user asks for a thread per item, launch each item they took as a
top-level thread. Never use a `delegate_task` subagent for this: it can't
watch CI, and it routes every answer through this thread.

```ts
t3_thread_launch({
  title: "#<N> <short title>",
  workspaceStrategy: { type: "worktree", baseRef: "origin/main" }, // its own checkout
  message: "<contents of /tmp/pr-queue/brief-<N>.md>",
})
```

Send the launches in batches of about 3: each one cuts a worktree, and cutting
many at once contends for git's locks. A PR's brief starts with `/audit <N>`.
An issue's brief says to fix it per [audit/procedure.md](../audit/procedure.md)
and open a PR ending in `Fixes #<N>`. Every brief carries the user's decision
on the card (and any reshape), plus:

- `pnpm install` first
- no subagents of its own
- one live suite at a time, with `--concurrency 8`
- `link_pull_request` on every PR
- after each push, `watch_pull_request` and end the turn
- every CI check passing on the final head before asking the user to merge,
  per [audit/procedure.md §7](../audit/procedure.md#7-report-and-ask)

If a thread fails in preparation, launch a fresh one.

Then keep a status table with a thread link per row
(`[title](t3-thread://v1/<threadId>)`) and a status (`todo` / `ready → merge?`
/ `close?` / `merged` / `closed` / `parked`). Don't do the items' work here and
don't poll the threads. When the user asks for status, `t3_thread_read` each
one and re-print the table.
