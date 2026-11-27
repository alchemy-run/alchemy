---
name: prepare-release
description: Prepare an alchemy release by converging the live test suite, unattended and in series — after one go-ahead, nuke the testing account, then walk every suite one at a time (Cloudflare → core unit → core integration → small providers → Fly → GCP → AWS → examples), fixing each until its whole suite passes in one run AND the account census is clean, and finish with one alchemy PR plus at most one distilled PR and one floci PR, all linked, that merge into a release passing every test. Use for "prepare a release", "/prepare-release", "prepare the release overnight", "release hardening run", "run the full suite before release", optionally scoped ("/prepare-release aws cloudflare"). To harden one provider's suite on its own, use the harden skill.
metadata:
  internal: true
---

# Prepare a release

This thread runs the whole release, **one suite at a time**. It owns every
step: the clean slate, each run, the fixes, type-checking, the census and the
PRs. It launches no subagents or threads, and it runs nothing in parallel with
a live suite. Going slowly in series is the point. A live suite under load
produces fake failures, parallel fixers on one account leak into each other's
census, and parallel type-checks and installs have crashed the machine.

A step is **done** when its whole suite passes in one run at the current head
and the census shows nothing new. The release is done when every step is done
at the final head, `pnpm test:examples` passes, and the account is clean. The
user merges; you never do.

The arguments name the scope: steps or providers from §2 (`aws cloudflare`),
or `all`. A scoped run walks only those steps, in §2's order.

## 0. One question, then unattended

Ask once, up front, in a single question. Confirm three things: the scope
(default: everything in §2), that you'll nuke the testing account before each
step for the whole run, and any opt-in tags or paid add-ons to include
(default: none; `optInTags` gate paid add-ons and entitlements, so never name
one unasked). **Nuking is destructive, so get an explicit yes.** After that,
never ask again. Take every decision yourself, record it in `STATE.md`, and
keep going. An answer you would have asked for goes in the final report.

Don't end the turn until §6 is done. Ending the turn ends the run. Wait on
long runs with `t3_background_wait`, never with `sleep` or a polling loop.

## 1. Preflight and durable state

**On every start, read `/tmp/release/STATE.md` first.** If it exists, resume
at the first step that isn't `done`. Don't restart the run.

Otherwise start from the latest `origin/main`, on a fresh branch:

```sh
git status                                   # must be clean; never git stash
git fetch origin main
git checkout -b release/prep-$(date +%Y-%m-%d) origin/main
git log -1 --format='%H %s' origin/main      # record as "Base" in STATE.md
git submodule update --init -- submodules/distilled
pnpm install
bun --version && node -v                     # must match package.json devEngines (bun 1.3.13, node 24)
set -a; source .env; set +a                  # pnpm download:env if missing
aws sso login                                # AWS live + nuke ride the SSO session
mkdir -p /tmp/release
pnpm exec tsrs -b                            # REQUIRED before live runs: emits distilled lib/
```

- If the global bun or node doesn't match, install a private copy
  (`mkdir -p /tmp/bun1313 && (cd /tmp/bun1313 && npm i --no-save bun@1.3.13)`,
  same for `node@24`) and put its `node_modules/.bin` first on `PATH`. A
  version warning from pnpm breaks `scripts/ensure-built.ts`.
- Env doesn't persist between shell calls. Put the `PATH` exports and the
  `.env` sourcing in `/tmp/release/env.sh` and source it before every command,
  commits included.
- Runtime bundles (Lambda, Fly, Hetzner, Neon Functions) resolve distilled
  through its `lib/` build output, not `src/`. Without the type-check, every
  deployed runtime crashes at boot with
  `Cannot find package '@distilled.cloud/…'`.
- Never set or unset `CI` for tests.

Don't merge `main` into the branch mid-run. A moving base would make every
`Passed at` meaningless. §6 picks up whatever landed meanwhile.

Keep the run's state in `/tmp/release/STATE.md` and update it after every
event. Context will be compacted many times, and this file is how you resume:

```md
# Release prep 2026-10-31 — branch release/prep-2026-10-31
Base: origin/main <sha> · Scope: all · opt-in: none · nuke authorized: yes
PRs: alchemy #— · distilled #— · floci #—

| # | Step | Command | Status | Passed at | Notes |
| - | ---- | ------- | ------ | --------- | ----- |
| 1 | Cloudflare | pnpm test:integration test/Cloudflare | done | a1b2c3d | |
| 2 | core unit | pnpm test | fixing (iter 2) | | Plan diff regression |

Gated: <test → typed tag + exact error>
Blocked (account, not code): <step → exact error>
Decisions: <ones you would have asked about>
```

## 2. The steps, in order

Cloudflare goes first. State and most other suites deploy through
`packages/cloudflare`, so getting it green first keeps its failures out of
every later step. After that, cheap and narrow first, so a broken shared
layer shows up in minutes, not after AWS. Paths are relative to
`packages/integration-tests`:

| # | Step | Paths | `--concurrency` |
| - | ---- | ----- | --------------- |
| 1 | Cloudflare | `test/Cloudflare` | 16 |
| 2 | core unit | `pnpm test` (packages/alchemy) | default |
| 3 | core integration | `test/*.test.ts test/Bundle test/Cli test/Local test/Runtime test/Util test/Website test/StateUpgrade` | 8 |
| 4 | building blocks | `test/Docker test/Redis test/Kubernetes test/SQL test/Drizzle test/Domain test/Auth test/DNS test/ACME test/Workflows test/Cluster` | 8 |
| 5 | Git, GitHub, Axiom, Stripe, Archil, Boat, 1password | one step each | 8 |
| 6 | Turso, Neon, Planetscale, Prisma, E2B, Daytona, Modal, Rivet, Convex, AI, Pi, OpenCode | one step each | 8 |
| 7 | Hetzner, Railway, DigitalOcean, Fly | one step each | 8 |
| 8 | GCP | `test/GCP` | 16 |
| 9 | AWS | `test/AWS` | 32 |
| 10 | examples | `pnpm test:examples --profile testing` | — |

Every top-level directory under `packages/integration-tests/test` gets a
step. Check before you start (`ls -d packages/integration-tests/test/*/`). If
one is missing from this table, add it to steps 5–7 by size, and fix this
skill in the release PR.

Never pass `--concurrency unbounded` or go over 32. Saturation shows up as
hundreds of 0ms `beforeAll` TimeoutErrors; real failures fail slow. A run that
selects 0 tests is an invocation bug (bad path, quoting), not a pass. Never
run a sequential monster file unfiltered in a fix iteration (e.g.
`Fly/BlueGreen.test.ts`, ~180 tests at ~100s each). Its confirming run is the
step's run.

## 3. One step

1. **Clean slate.** First check that no other thread is mid-suite on the
   account (`ps -eo etime,command | grep alchemy-test`): the nuke deletes
   every alchemy-tagged resource whatever its stage, and kills their tests.
   Wait for them. Then:
   ```sh
   pnpm nuke --yes --profile testing            # no --yes hangs; --profile is required
   pnpm nuke --dry-run --profile testing > /tmp/release/census-<step>-before.txt
   ```
   Before step 1 only, also clear the test state:
   `pnpm clear:state --profile testing --yes --no-input`. What the census
   still lists is residue (`scripts/nuke.sh` excludes, e.g.
   `AWS.BackupSearch.SearchJob`, zone singletons). A holdout that survives two
   nukes is a stuck delete in that provider: its `list` or `delete` is the
   bug. Fix it in this step.
2. **Run** the step in the background, with the output written to a file:
   ```sh
   source /tmp/release/env.sh
   pnpm test:integration <paths> --profile testing --concurrency <n> \
     > /tmp/release/<step>-run-<k>.out 2>&1
   ```
   Wait on it with `t3_background_wait`. Start triage as soon as failures
   stream in (`grep -E "\] ✗ |failed to run|^Tests:"`; a bare `✗` also
   matches the `[n/N ✓ ✗]` progress counter). The full record of every test is
   under `packages/integration-tests/.alchemy/log/test/`. A test running far
   past its timeout is a hang. Read its log and fix the cause.
3. **Census.** Once the run has finished, save `pnpm nuke --dry-run --profile
   testing` to `census-<step>-after.txt` and diff it against `-before`. Every
   new line is a leak, even from a green test. Leave leaks live while you fix
   them, since they're your evidence.
4. **Fix** every failure and leak (§4). Re-run only the failing files, with
   `-t` when a file is long, until each one passes. Never re-run the whole
   step to check one fix.
5. **Budget.** Give a failure three fix iterations. If the blocker is
   platform behavior (entitlement, slow async provisioning, beta API), gate it
   on the typed tag with the exact error, keep an ungated probe, and move on.
   If the blocker is the account (billing, token permissions, a retired
   service), mark the step `blocked` with the exact error and move on. Never
   enable billing or edit shared tokens.
6. **Confirm.** If anything changed, nuke, then run the **whole step once
   more** and take another census. The step is `done` only when one single
   run is green and its census diff is empty. Record the HEAD sha in
   `Passed at`. A step that was green and clean on its first run is done
   without a second one.
7. **Gate and push.** Run `pnpm exec tsrs -b`, and `pnpm docs:check-jsdoc` if
   any props changed. Commit one commit per fix, scoped (`fix(aws/ec2): …`),
   then push the alchemy branch and any distilled/floci branch (§6).

## 4. Fixing

Classify each failure, and stop at the first bucket that applies:

| Bucket | Signal | Fix lands in |
| --- | --- | --- |
| Provider bug | wrong read/diff/reconcile/delete, leak, crash | `packages/<provider>/src/…` (alchemy PR) |
| Untyped error | `Unknown*Error`, out-of-union status error, wrong schema | distilled patch (distilled PR) |
| Emulator bug | only fails under floci | `submodules/floci` (floci PR) |
| Test bug | shared or hard-coded name or stage, missing lock label, unbounded wait | the test |
| Eventual consistency | a call raced the cloud | a bounded retry in the test, at that call |
| Slow by nature | image builds, cold starts | a longer timeout, matching its neighbors |
| Platform/entitlement | plan-gated, beta API, quota | `test.provider.skip` or a skipIf gate on the typed tag, quoting the exact error |

Rules:

- **Provider bug > distilled patch > test fix**, and a longer timeout comes
  last. Never paper over a leak or an untyped error in a test.
- **The release PR hardens tests; it doesn't change behavior.** Touch
  provider, binding or bundler code only for a real provider bug: a leak, a
  wrong diff, an untyped error. No readiness probes in `reconcile`, and no
  blanket retries in bindings to make a propagation race pass.
- **Never widen a permission** (IAM `Resource: ["*"]`, a broader token group)
  to make a test pass.
- **A failure that also fails on `main` is still yours to fix.** It just
  isn't a regression; list it as pre-existing in the report.
- **"Flaky" is usually two runs touching one cloud object**: a shared name or
  stage, a missing `exclusive: "<label>"`, a retry that leaks. Re-run it alone
  before deciding. The isolation rules and the provider-bug patterns in the
  [harden skill](../harden/SKILL.md) apply. When a step stays intermittent,
  run harden's loop on it.
- **Names.** Let the resource generate the physical name. Only a test about
  explicitly provided names passes one, derived from `stack.stage`. Never
  `Date.now()`, UUIDs or random values. Fix any hard-coded name you find in a
  suite you touch.
- **Distilled patches** follow AGENTS.md's Typed Error Doctrine: patch,
  regenerate only that service, and re-run. Tests resolve distilled from
  `src/`, so there is nothing to rebuild or wait for. Run `pnpm` commands
  from the repo root, never inside `submodules/distilled`.
- **One slow or exclusive test must never hold up the rest of a run.** Narrow
  the lock (`{ exclusive: "aws:ses-account" }` instead of `exclusive: true`);
  don't lower concurrency and don't wait it out.
- Review your own diff before committing: no caught catch-all error, widened
  cast, `Effect.orDie` in a lifecycle op, mocked response, or skip without a
  typed reason.

## 5. Keep earlier steps valid

A later fix can break an earlier step. The release needs every step to pass
at the **final** head, not just at the head where it once passed. After each
step, check what has changed since each `done` step passed:

```sh
git diff --name-only <passed-at>..HEAD
```

Mark a step `stale` when that list touches `packages/alchemy/`,
`packages/alchemy-test/`, its own provider packages, a package its tests
deploy through (most suites deploy through `packages/cloudflare` for state),
or the distilled/floci pins. Before step 10, re-run every stale step (§3.1–6)
in order until none is left. When a fix only touches one provider's own
package or tests, the other steps stay valid.

## 6. PRs, linked

There are at most three PRs: alchemy, distilled and floci. Open the alchemy
PR as a **draft** at the first fix commit, and push after every step, so a
crash loses nothing.

**distilled** (only if there are patches) — work in a standalone clone, never
a `git worktree add` from inside `submodules/distilled` (its `core.worktree`
belongs to another checkout):

```sh
git clone --reference submodules/distilled https://github.com/alchemy-run/distilled /tmp/release/distilled
cd /tmp/release/distilled && git checkout -b fix/release-prep-$(date +%Y-%m-%d)
# copy the patches + regenerated services from submodules/distilled, commit per service
```

Title: `fix: typed errors and schema fixes from release prep`. The body lists
each patch with the error it types, e.g. `R2 putBucketLifecycle: code 10058 →
LifecycleRuleInvalid`.

**floci** (only if emulator fixes are needed) — floci is skipped by default
(`git submodule update --init --checkout -- submodules/floci`); use the same
standalone-clone pattern against `https://github.com/alchemy-run/floci`. If
alchemy needs the new emulator image, it needs a release tag.

**alchemy** — branch `release/prep-<date>`, title
`fix: release hardening (<date>)`. It contains the provider, test, gating and
tagging fixes, plus the submodule pins.

- alchemy's branch pins `submodules/distilled` / `submodules/floci` at the
  current heads of their PR branches, and pushes a bump each time those
  branches move.
- Link them both ways. Put `Requires alchemy-run/distilled#X` (and floci) in
  the alchemy body, and `Required by alchemy-run/alchemy#Y` in each upstream
  body. Write the merge order distilled → floci → alchemy into the alchemy
  body.
- Descriptions follow AGENTS.md's PR conventions: one plain sentence, then
  user-facing snippets or a per-service table of what was fixed. No `#`/`##`
  headings and no test plan. Write the body to a file and pass `--body-file`.
- `link_pull_request` every PR to this thread.
- Mark the PRs ready only at §7, once everything is `done`.

## 7. Finish

After step 10 is done and no step is stale, `git fetch origin main`. If
`main` has moved past `Base`, merge it, resolve any conflicts, run
`pnpm exec tsrs -b`, and apply §5 to the merged changes. Re-run every step it
marks stale, and step 10 if any step re-ran. Repeat until a fetch finds
nothing new. The PR must be mergeable at a head that already contains the
latest `main`. Then nuke one last time and take a final census. It must show
residue only. Then, and only then, mark the PRs ready and end the turn with
the report:

```md
### Release ready at <sha>. I recommend merging, in this order:

1. distilled — <what it types> — https://github.com/alchemy-run/distilled/pull/X
2. floci — <what it fixes> — https://github.com/alchemy-run/floci/pull/Z
3. alchemy — <K> fixes, <G> gated tests — https://github.com/alchemy-run/alchemy/pull/Y

| Step | Tests | Result | Passed at |
| ---- | ----- | ------ | --------- |
| Cloudflare | 1577 | ✅ | a1b2c3d |
| AWS | 3361 | ✅ 3349 · 12 gated | f00ba47 |
| examples | 38 | ✅ | f00ba47 |

Gated: <test → typed tag + exact error>.
Blocked (account): <step → exact error>.
Fails on main too (pre-existing, now fixed): <list>.
Decisions taken unattended: <ones you'd have asked about>.
Census: clean except <documented residue>.
```

After each upstream PR merges, the submodule has to be repointed at its
`main` merge commit (never a side branch) and the steps that commit
invalidates have to be re-run. Say so in the report rather than claiming the
release is final. Say plainly what didn't run (out-of-scope steps, opt-in
tags, blocked steps). Don't report CI status in place of these results.

## Pitfalls

- **The SSO session expires mid-run.** An AWS step failing in ~100ms at setup
  means the token is gone. Run `aws sso login` again. If that needs a human,
  mark the step `blocked`, go on to the non-AWS steps, and come back to it. A
  suite that also deploys to another cloud leaks on teardown when that
  cloud's session expires; rerun the file to clean up.
- **Never overlap nuke with a run**, and never start a step's run before its
  nuke has finished.
- **Steps share one account.** A leak from step 4 shows up in step 5's census
  unless step 4's confirming census was clean. Don't move on with a dirty
  census.
- **Other sessions share the account too.** Another worktree's live resources
  show up in your census; check `ps -eo etime,command | grep alchemy-test`
  before chasing a leftover you can't trace to your own run. A linked
  worktree defaults to its own test stage (`test_$USER_<worktree>`); suites
  that set their own stage must prefix it with `Test.defaultStage()`.
- **`DynamoDB state table 'alchemy-state' never became ACTIVE`** means a nuke
  scheduled the state store's KMS key for deletion. `aws kms
  cancel-key-deletion` + `enable-key` on the table's `KMSMasterKeyArn`
  restores it in minutes; then fix the spare filter in `scripts/nuke.sh`.
- **Commit with the pinned env sourced.** The pre-commit hook runs pnpm; with
  the wrong bun/node or a stray temp workspace dir under `examples/` (left by
  a killed test) it re-installs and rewrites `pnpm-lock.yaml`. Never commit
  the lockfile or Prisma `generated/contract.*` churn.
- **A nested install in `submodules/distilled`** brings a second `effect`
  copy ("Unable to get redacted value", `[NodeInspectSymbol]` mismatches).
  Move `submodules/distilled/node_modules` and its `packages/*/node_modules`
  aside, `pnpm install` at the root, and type-check with
  `pnpm exec tsrs -b --force`.
- **Provider `console.log` doesn't reach the run log.** Debug with
  `Effect.logInfo`, and probe API behavior with a throwaway test file rather
  than guessing.
