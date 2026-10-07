---
name: pr-queue
description: Run a pull-request (or issue) queue for an area of alchemy — search GitHub for open PRs/issues matching a criteria (e.g. "cloudflare", "docker", "aws/rds", an author, a label), shortlist the top 10 ordered by ease of fixing, then work through them one at a time: check out, merge main, resolve conflicts, audit tests and JSDoc, run the suites, rewrite the PR description as DX snippets, and stop with a merge-or-close recommendation. Use for "start working on a pull request queue for cloudflare", "PR queue for docker", "triage open PRs for X", "work through the open fix(aws) PRs", "next PR" while a queue is running.
---

# Pull request queue

This session is a queue. Build the list once, then process exactly one PR per
turn and stop for a decision before taking the next one.

## 1. Build the queue

Turn the user's criteria into a search. An area like `docker` or `cloudflare`
matches conventional-commit scopes (`feat(docker)`, `fix(cloudflare/r2)!`) and
PRs that touch that provider's paths.

```sh
gh pr list --state open --limit 300 --json number,title,author,isDraft,mergeable,additions,deletions,changedFiles,updatedAt,isCrossRepository,maintainerCanModify,headRefName,url \
  > /tmp/pr-queue.json
# scope match: ^\w+!?\((<area>)(/[^)]*)?\)!?:   (case-insensitive)
# path match for anything the title missed:
gh pr view <n> --json files --jq '.files[].path' | grep -i '<Area>/'
```

For issues, use `gh issue list --state open --search "<area> in:title,body"`
the same way. Free-form criteria (author, label, "anything touching the
engine") map onto `--author`, `--label`, `--search`.

Print the full match list as a table (`#`, title, author, +/−, files,
mergeable, draft, updated), then the **shortlist of the top 10 ordered easiest
first**. Rank by:

1. `mergeable` is `MERGEABLE` (no conflicts) before `CONFLICTING`
2. small diff and few files
3. already includes tests in the right shape
4. not a draft, recently updated, single concern
5. fork PRs without `maintainerCanModify` last (we cannot push to them)

Give each shortlisted PR a one-line note on what it does and what looks like
work. Then start on #1 of the shortlist unless the user wants to reorder.

Keep the shortlist as a status table and re-print it at the end of every turn
(`todo` / `ready → merge?` / `close?` / `merged` / `closed` / `skipped`).

## 2. Process one PR

Start from a clean tree (`git status`). Never `git stash` — the stash stack is
shared with other worktrees and sessions. Commit or discard instead.

### Check out and merge main

```sh
gh pr view <n> --json headRepositoryOwner,headRepository,headRefName,maintainerCanModify,body,files
gh pr checkout <n>
git fetch origin main && git merge origin/main
```

Resolve conflicts by understanding both sides. Main wins on code that has
since been refactored; port the PR's intent onto the new shape rather than
reviving old code. If `submodules/distilled` conflicts or drifts, take main's
pin unless the PR carries a distilled patch it needs.

If the environment is broken rather than the code (missing `node_modules`,
distilled behind its pin, `@alchemy.run/floci` unresolved), run
`git submodule update --init -- submodules/distilled && pnpm install`.

### Review the code

Read the whole diff against `origin/main` and apply AGENTS.md. In particular:

- **Tests exist** for the change: new cases or updated ones in the owning
  suite (`packages/alchemy/test/{Cloud}/{Service}/{Resource}.test.ts`).
- **Tests only use** `test.provider` with `stack.deploy`/`stack.destroy`, or
  `beforeAll(deploy(Stack))` / `afterAll(destroy(Stack))` fixtures. Reject
  mocked HTTP/SDK responses, direct calls to provider lifecycle methods, and
  one-off helpers extracted only so they can be unit-tested. Pure utility and
  engine unit tests are fine for their own behavior.
- **Per-developer isolation**: no hard-coded account- or zone-unique physical
  names. Prefer engine-generated names; otherwise derive from `stack.stage`.
- Reconciler doctrine (observe → ensure → sync, no create/update branch),
  Typed Error Doctrine (no catching catch-all errors by status — patch
  distilled), no `Effect.orDie` in lifecycle ops, no raw Promise/`node:fs`.

Fix what is fixable yourself — missing tests, test-shape violations, doctrine
violations. If the PR is fundamentally wrong (wrong approach, superseded by
main, duplicate), stop fixing and recommend closing.

### Update JSDoc

Every changed or new prop/attribute has field-level JSDoc (with `@default`
where relevant), and the resource-level JSDoc has `###` sections with
`**Example:**` snippets covering the new behavior, metadata tags last. Then:

```sh
pnpm docs:check-jsdoc
pnpm docs:gen   # commit regenerated website/src/content/docs/providers/** if it changed
```

Never hand-edit generated provider markdown.

### Run the tests

- Run **each touched test file in full**, plus the suites that cover the
  changed source modules — not just the new case via `-t`.
- Prove the change matters: the new/changed case **fails on main** (revert
  only the `src/` change in place, run, restore with `git checkout -- <file>`)
  and passes with it. `packages/frontend-frameworks` is consumed from `dist/`
  — rebuild with `npx tsdown` around that check or it proves nothing.
- Wrap every run: `timeout 240 pnpm test <file> --profile testing`.
- Cloudflare live: `set -a; source .env; set +a` first (`pnpm download:env` if
  missing). Never set `CI=false`. AWS live needs SSO; if credentials are
  unavailable, say so rather than skipping silently.
- Run `pnpm exec tsc -b` too, but only surface it if it fails.

### Push

Commit fixes and the main merge, check `git diff --stat origin/main...HEAD`
for unrelated files the pre-commit formatter swept in, then push to the PR's
head branch (forks included when `maintainerCanModify`). If you can't push,
say so in the report.

### Rewrite the PR description

Write the body to a file and apply it with
`gh pr edit <n> --body-file /tmp/pr-<n>.md`. Shape (per AGENTS.md):

- one plain sentence on what changes and why — no heading above it
- `ts` snippets of how a user writes the new/fixed API (props, values,
  variants); a `diff` when showing before/after DX
- prose only for the "why" a snippet can't show
- no `##`/`#` headings, no bullet dumps, no Tests/Checks/test-plan sections
- end with the Claude Code attribution line

Then `gh pr ready <n>` if it is a draft and you judge it ready. If the T3
`link_pull_request` tool is available, link the PR to this thread.

## 3. Stop and report

End the turn after each PR. The report is short:

1. **Recommendation**: merge or close, with the justification (what it fixes,
   why it is correct, what you changed; or why it should be discarded —
   superseded by `<commit/PR>`, wrong approach, abandoned, duplicate).
2. **Tests run**: each file path (and case names when relevant), live vs
   local, pass/fail counts, and the fails-on-main result. Do not pad with CI
   or tsc status.
3. Anything outstanding or that needs the user's call.
4. The updated queue status table.
5. **Last line: the full PR URL.**

Never merge or close a PR yourself — wait for the user. When they say
merge/close/next/skip, act on it (`gh pr merge <n> --squash` /
`gh pr close <n> --comment "<reason>"` only on their instruction), update the
table, and continue with the next shortlisted PR.
