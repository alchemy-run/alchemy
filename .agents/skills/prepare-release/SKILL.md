---
name: prepare-release
description: Prepare an alchemy release by converging the live test suite — nuke + clear:state the testing account, run every test through a tag-driven `--plan` (unit → per-provider live in parallel → local), triage failures as they stream in, fan out one fix agent per failing/leaking service, census leaks, and loop until two consecutive rounds are green and clean. Fixes land as one alchemy PR plus at most one distilled PR and one floci PR. Use for "prepare a release", "/prepare-release", "release hardening run", "run the full suite before release", optionally scoped ("/prepare-release aws cloudflare").
---

# Prepare a release

This session is the **coordinator** of the convergence loop in AGENTS.md
("The convergence loop: nuke → test → census → fix-fleet"). You own the clean
slate, the test runs, triage, type-checking, the census, and the PRs. Fix
agents own one service each. The user merges; you never do.

The arguments name the scope: providers (`aws cloudflare gcp …`) or `all`. With
no arguments, propose a scope (default: unit + local + every `provider:*` live
tag) and confirm it together with the nuke in a single question. **Nuking the
testing account is destructive — always get an explicit go-ahead first.**

## 0. Preflight

Start from a clean, up-to-date `main` in this worktree, on a fresh branch:

```sh
git status                                   # must be clean; never git stash
git fetch origin main && git checkout -b release/prep-$(date +%Y-%m-%d) origin/main
git submodule update --init -- submodules/distilled
pnpm install
bun --version                                # must be 1.3.13 — 1.4 fails every file at collection
# if not: mkdir -p /tmp/bun1313 && (cd /tmp/bun1313 && npm i --no-save bun@1.3.13)
#         export PATH=/tmp/bun1313/node_modules/.bin:$PATH   (prefix every pnpm test with this)
set -a; source .env; set +a                  # Cloudflare creds (pnpm download:env if missing)
aws sso login                                # AWS live + nuke ride the SSO session
mkdir -p /tmp/release
```

Never set or unset `CI` for tests (a profile-store migration can wipe
`~/.alchemy`). If an AWS run fails in ~100ms during setup, the SSO session has
expired — re-run `aws sso login`.

## 1. Clean slate

```sh
pnpm nuke --yes --profile testing            # scripts/nuke.sh requires --profile; no --yes hangs
pnpm clear:state --profile testing
pnpm nuke --dry-run --profile testing > /tmp/release/census-0.txt   # baseline; should be residue only
```

Never run nuke while any suite is running. Holdouts that survive two nuke
passes are stuck deletes — put that service on the worklist; its delete path is
the bug. Documented-undeletable residue (excluded in `scripts/nuke.sh`, e.g.
`AWS.BackupSearch.SearchJob`, zone singletons) is not a finding.

## 2. Build the plan and dry-run it

Tests carry tags (`unit`, `live`, `local`, `provider:<cloud>`,
`provider:<cloud>:<service>`). `--tags` takes expressions with `&&`, `||`, `!`,
parentheses and `*`; `--plan` takes a JSON array of sequential phases, where a
nested array runs branches in parallel and **the first matching branch wins**.
Tags listed under `optInTags` only run when named explicitly (wildcards and
negations don't count) — never name one without asking; they gate paid add-ons
and entitlements.

Default plan (drop providers outside the scope):

```json
[
  { "tags": ["unit && !live"] },
  [
    { "tags": ["live && provider:aws"],        "concurrency": 32 },
    { "tags": ["live && provider:cloudflare"], "concurrency": 16 },
    { "tags": ["live && provider:gcp"],        "concurrency": 16 },
    { "tags": ["live && !provider:aws && !provider:cloudflare && !provider:gcp"], "concurrency": 8 }
  ],
  { "tags": ["local"], "concurrency": 8 },
  { "tags": [] }
]
```

- Phase 1 runs the unit tests first: a broken unit layer makes every live
  failure noise, so stop and fix it before spending cloud time.
- The final `[]` branch is the catch-all for untagged tests. Everything it
  picks up is a tagging gap — add the missing tags in the release PR.
- Never use `"unbounded"` and never exceed 32 per branch. Saturation shows up
  as hundreds of 0ms `beforeAll` TimeoutErrors; real failures fail slow.

Write the plan to `/tmp/release/plan.json` and preview it:

```sh
pnpm test --profile testing --plan "$(cat /tmp/release/plan.json)" --dry-run
```

For reference, on 2026-10-09 the default plan selected 11,614 tests in 2,880
files (unit 3,089 · aws 3,361 · cloudflare 1,577 · gcp 2,085 · other live
811 · local 592 · untagged 99 in 19 files). Collection takes ~10s. Check
the branch counts against expectations. A branch with 0 tests is an
invocation bug (bad tag, quoting), not a pass. Show the user the preview
before the real run.

## 3. Run it

Run in the background so you can triage while it streams:

```sh
pnpm test --profile testing --plan "$(cat /tmp/release/plan.json)" \
  > /tmp/release/round-1.out 2>&1
```

Note the `Full log: .alchemy/log/test/…` path at the end. Failures print
inline with their error as soon as they happen, so start triage at the first
failure rather than waiting for the run to finish. If nothing finishes for 10s
the runner lists running tests — a test stuck far past its timeout is a hang
to fix, not something to wait out.

## 4. Triage

Group failures by their most specific `provider:<cloud>:<service>` tag (the
service is the unit of ownership). Classify each:

| Bucket | Signal | Fix lands in |
| --- | --- | --- |
| Provider bug | wrong reconcile/diff/delete, leak, crash | `packages/alchemy/src/…` (alchemy PR) |
| Untyped error | `Unknown*Error`, out-of-union status error, wrong schema | distilled patch (distilled PR) |
| Emulator bug | only fails under floci | `submodules/floci` (floci PR) |
| Test bug | non-deterministic name, unbounded wait, missing propagation retry | the test (alchemy PR) |
| Platform/entitlement | plan-gated, slow async provisioning, beta API | skipIf-gate on the typed tag + exact error, keep an ungated probe |
| Flake | passes alone, fails under load | re-run alone and on main first |

Root-cause priority is **provider bug > distilled patch > test fix**. Never
paper over a provider leak or untyped error in a test. For suspected flakes,
build a verdict table: `Failure | Re-run alone | On main | Verdict`. A failure
that also fails on main is still in scope for the release — it just isn't a
regression.

## 5. Census

After the run finishes (and never while one is running):

```sh
pnpm nuke --dry-run --profile testing > /tmp/release/census-1.txt
diff /tmp/release/census-0.txt /tmp/release/census-1.txt
```

Every new resource is a leak, and a green service can still leak. **Leave the
leaked resources live** as evidence for the fix agents. The worklist is
failing services ∪ leaking services.

## 6. Fix fleet

Spawn one agent per service on the worklist, in parallel (~12 at once;
account-singleton services like CloudTrail, Config, SecurityHub, GuardDuty,
ControlTower and IdentityCenter run as one sequential chain). Agents work in
this worktree and **commit but don't push**; they touch only their service's
files, plus single minimal insertions in shared files. The prompt is a
contract — include every item:

1. The service it owns, its directory, and its tag (e.g. `provider:aws:ec2`).
2. Its exact failures (error text + test names) and its leak inventory from the
   census diff.
3. Assess-first: partial work may exist from an interrupted run; finish it
   rather than rewriting.
4. Reading list: AGENTS.md Reconciler doctrine + Typed Error Doctrine + speed
   doctrine, the resource source, the test, and the distilled service +
   existing patches.
5. Root-cause priority (provider > distilled > test) and the rule that it
   never hides a leak in the test.
6. **No `tsc`, no `pnpm build`, no `pnpm nuke`** — the coordinator owns these.
7. Speed doctrine: every run is
   `timeout 240 pnpm test --tags '<its tag>' --profile testing`; per-test
   timeouts ≤ 90–120s; every retry bounded (`times ≤ 8–10`, < 60s total);
   three-iteration budget, then gate and report.
8. Distilled patches for its service only, regenerated in place:
   - Cloudflare: `cd submodules/distilled/packages/cloudflare && bun scripts/generate.ts --resource <svc> && pnpm exec oxfmt src/services/<svc>.ts`
   - AWS: `cd submodules/distilled/packages/aws && bun scripts/generate.ts --sdk <svc>`
   Tests resolve distilled from `src/`, so there's nothing to rebuild or wait for.
9. Test rules: start and end with `stack.destroy()`, deterministic names
   (engine-generated or derived from `stack.stage`), out-of-band verification
   through distilled, no mocks.
10. Done means: its **full** tag passes, and distilled list/describe calls show
    zero orphans from its service.
11. Structured result: `{ service, tag, testsPassed, testCommand, rootCause,
    files, patches (with reasons), skippedTests (with exact errors), leaksFixed,
    notes }`.

While agents run, watch for stalls: a transcript that hasn't been written for
~5 minutes with no child test process is stalled — kill and re-dispatch it.

When results come in, review each diff yourself before accepting it. Reject
any that catch a catch-all error, widen a cast, add `Effect.orDie` to a
lifecycle op, mock a response, or skip a test without a typed reason.

## 7. Gate

```sh
pnpm exec tsc -b                             # coordinator only, once per round
pnpm docs:check-jsdoc                        # if any props/attrs changed
```

Fix cross-cutting fallout yourself (`Providers.ts` nested `Layer.mergeAll`
groups, barrel conflicts). Commit the round — one commit per service fix,
conventional-commit scoped (`fix(aws/ec2): …`) — and **push immediately**.

## 8. Loop

Go back to §1 (nuke + clear:state + baseline) and run the plan again. In
intermediate rounds you may narrow the live phase to the worklist tags
(`live && (provider:aws:ec2 || provider:cloudflare:r2)`), but the final two
rounds are the **full plan**.

Stop when two consecutive full rounds are green and the census diff is only
documented-undeletable residue. If a round gets worse, find out which fix
regressed before dispatching anything else.

Report each round to the user, briefly:

```md
### Round N: 1834 passed · 12 failed · 3 leaking services

| Service | Tag | Failure | Bucket | Status |
| --- | --- | --- | --- | --- |
| EC2 | provider:aws:ec2 | InternetGateway delete timeout | provider bug | fixed, 63/63 |
| R2 | provider:cloudflare:r2 | UnknownCloudflareError 10058 | distilled | patched, 30/30 |

Next: round N+1 (full plan).
```

## 9. PRs

At most three, one per repo. Open them as soon as there is a first fix, and
push every later fix promptly.

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
standalone-clone pattern against `https://github.com/alchemy-run/floci`. If alchemy needs the new emulator image, it needs a release
tag.

**alchemy** — branch `release/prep-<date>`, title
`fix: release hardening (<date>)`. It contains the provider, test, gating and
tagging fixes, plus submodule bumps pointing at the distilled/floci PR heads.
The merge order is distilled → floci → alchemy. After each upstream PR merges,
repoint the submodule at its **`main` merge commit** (never a side branch),
rerun the affected tags, and push.

Descriptions follow AGENTS.md's PR conventions: one plain sentence, then
user-facing snippets or a per-service table of what was fixed. No `#`/`##`
headings and no test plan. Write the body to a file and pass `--body-file`.
Link every PR to this thread with the T3 `link_pull_request` tool when it's
available. Leave PRs as drafts until the gate passes, then `gh pr ready`.

## 10. Final report

End with the merge ask:

```md
### Release prep converged after N rounds. I recommend merging, in this order:

1. distilled — <what it types>
   https://github.com/alchemy-run/distilled/pull/X
2. alchemy — <K> service fixes, <G> gated tests, <T> tagging fixes
   https://github.com/alchemy-run/alchemy/pull/Y

| Phase | Tests | Result |
| --- | --- | --- |
| unit | 856 | ✅ |
| live provider:aws | 1662 | ✅ 1650 · 12 skipped (gated) |
| … | | |

Gated (needs entitlement / platform): <test → exact error>.
Fails on main too (pre-existing, now fixed): <list>.
Census: clean except <documented residue>.
```

Say plainly what was **not** run (out-of-scope providers, opt-in tags). Don't
report CI status in place of the test results.
