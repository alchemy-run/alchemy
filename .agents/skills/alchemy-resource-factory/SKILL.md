---
name: alchemy-resource-factory
description: Orchestrate Alchemy resource-factory agent waves.
---

# Alchemy Resource Factory

## When to use

Load before coordinating multi-agent provider coverage, live-test waves, or cleanup convergence loops.

# The Resource Factory Process

Alchemy resource coverage is produced as a **software factory**: fleets of agents implement and live-test IaC resources in waves, and every API mismatch the tests surface is fed back as a patch to distilled. The factory was used to take Cloudflare from 36 to 239 cataloged resources (250 test files / 600+ test cases, 1000+ patched operations) and is the template for every future provider.

## The flywheel

```
 catalog ──> implement ──> live test ──> unmatched error / wrong schema?
    ^                                          │
    │                                          v
 update statuses <── regenerate service <── patch distilled
```

1. **Catalog** — fan out research agents over the provider's distilled service modules (one batch per thematic group). Each agent reads the generated SDK (`submodules/distilled/packages/{cloud}/src/services/{service}.ts`), cross-references the vendor API docs, and writes a self-contained design spec to `processes/{Cloud}/catalog/{service}.md`: resources, namespaces, props/attrs with replacement rules, lifecycle-to-operation mapping, scope (account/zone), testability, priority. The coordinator aggregates a machine-readable `summary.json` + human `INDEX.md` that tracks `implemented | partial | missing` per resource — this is the factory's order book.
2. **Implement + test** in waves (below). Tests run against the real cloud (`pnpm test --profile testing`); zone-scoped tests use the standing test zone (`alchemy-test-2.us` via `findZoneByName`).
3. **Patch the SDK, never the consumer** — every `UnknownCloudflareError`, out-of-union status error, or wrong request/response schema found by a test becomes an RFC 6902 JSON Patch against the service's Smithy model, under `submodules/distilled/packages/{cloud}/patches/{service}/{op}.json` (see [Alchemy typed errors](../alchemy-typed-errors/SKILL.md)). Regenerate only that service. The typed union improves for every future consumer of the SDK — that is the flywheel's output.
4. **Update the catalog** statuses after each wave and pick the next batch from the order book. Repeat until everything left is documented as out of scope (deprecated APIs, billing/data-only endpoints, closed-beta, needs-external-systems).

## Orchestration rules (the coordinator)

- **One workflow at a time**, ~12 concurrent agents (cap ≈ CPU cores − 2). Two parallel workflows double throughput but also double crash blast-radius — only do it when the machine and budget clearly allow.
- **One agent per distilled service.** Service ownership is the unit of isolation: only the owner may touch `patches/{service}/` and regenerate `src/services/{service}.ts`, so generator runs never race. An agent may own several resources of its service; a very large same-service backlog (e.g. zero-trust) runs as a **sequential chain** of agents inside the workflow, in parallel with all other services.
- **Shared-file discipline.** `Providers.ts` and the provider barrel `index.ts` are edited by every agent: single minimal insertions only, re-read and retry on edit conflict, never rewrite wholesale.
- **`Layer.mergeAll` ceiling.** Keep `Providers.ts`'s provider layers in *nested* `Layer.mergeAll` groups (~90 entries each). A flat ~200-argument call exceeds tsc's variadic inference and **silently drops the tail layers** from the inferred union, producing baffling `Provider<X> is not assignable to StackServices` cascades across every test file.
- **Crash resilience.** Word every task as *assess-first*: "partial work may exist from an interrupted run — list your dirs, read existing files, check registration, FINISH rather than rewrite." Completed agent results are banked in the workflow journal even if the workflow dies; the coordinator recovers them from `journal.jsonl` and re-dispatches only the lost tasks.
- **The coordinator (not agents) does**: the authoritative type-check, distilled lib rebuilds, combined verification runs, catalog/index updates, cross-cutting fixes (shared-file restructures, Effect-version API migrations), and deterministic mass transforms (mechanical codemods are scripted centrally, not fanned out).
- **Monitor for stalls**: an agent transcript that hasn't been written for ~5 minutes with no child test process is stalled — kill and re-dispatch; don't wait.

## Resource budget: one type-checker for the whole factory

`tsc -b` over the workspace is expensive; dozens of agents running it concurrently thrashes the machine (and concurrent `tsbuildinfo` writes race). Instead:

- **Agents are banned** from running `tsc` or `pnpm build` (root or distilled) in any form. The coordinator owns type-checking and runs a one-shot `pnpm exec tsc -b` at wave boundaries.
- **The test runner resolves distilled from `src/*.ts` directly, NOT the built `lib/`** (`alchemy-test` runs in plain bun, which resolves the `bun` export condition natively). So a regenerated service is **immediately test-visible** the moment `bun scripts/generate.ts --resource {service}` (+ oxfmt) finishes — there is nothing to rebuild and **nothing to wait for**. Do NOT sleep and do NOT gate a test re-run on a build after regenerating. This applies to response-schema patches as well as error-tag-only patches.

## Speed doctrine: never wait on a hang

- Run tests with `pnpm test` (works from the repo root or `packages/alchemy`; suite paths are relative to `packages/alchemy`, e.g. `test/Cloudflare/...`). Wrap **every** test invocation in a hard kill: `timeout 240 pnpm test <suite> --profile testing`. Hitting the wall **is** the failure — read the partial output (and the run's log under `.alchemy/log/test/`), find the hang (unbounded retry, infinite pagination, the engine deadlock below), fix the root cause. Never just re-run hoping. The runner also prints the currently-running tests whenever nothing finishes for 10s — use that list to identify the hang.
- Per-test timeout ≤ 90–120s (`{ timeout: ... }` on the test, or `--timeout` for the whole run). A suite needing more than ~3–5 minutes total is a bug.
- Every `Effect.retry`/`Effect.repeat` is bounded: `times ≤ 8–10`, total backoff under ~45–60s. Never poll for asynchronous provisioning slower than ~90s — skipIf-gate instead.
- **Known engine bug**: a deploy that *replaces* a resource while simultaneously *removing* its old dependency deadlocks. Keep both dependencies deployed across replacement steps in tests (see `test/Cloudflare/R2/BucketEventNotification.test.ts`).
- **Three-iteration budget**: if a suite is not green after ~3 fix iterations and the blocker is platform behavior (entitlement, slow async provisioning, beta API), implement fully, skipIf-gate with the typed tag and exact error, verify a skip-clean run, and report honestly. Do not burn an hour on one resource.

## Entitlement gating pattern

Most enterprise/plan-gated resources are still fully implementable; only the live lifecycle is gated:

1. **Probe once** against the real API to capture the exact rejection (code + message). If it surfaces as an untyped catch-all, patch distilled first so the entitlement error is a typed tag (e.g. `MagicTransitNotOnboarded` code 1012, `SaasQuotaNotAllocated` code 1404, `AdvancedCertificateManagerRequired` code 1450).
2. Keep an **ungated probe test** that asserts the typed tag is returned — this proves both the patch and the gating are correct, forever, at near-zero cost.
3. skipIf-gate the full lifecycle behind an env var (`CLOUDFLARE_TEST_MAGIC_TRANSIT=1`, `CLOUDFLARE_TEST_DLP=1`, …) so an entitled account can run it unchanged.
4. Record the testability verdict (`yes | limited | no`) and the exact error in the catalog notes.

Deprecated APIs (superseded by Rulesets etc.), billing/subscription objects, pure data-APIs, and closed-beta endpoints are *documented as out of scope* in `INDEX.md` rather than implemented.

## What every agent task prompt must include

A wave task prompt is a contract. Include, every time:

1. The **distilled service the agent owns** and the resources to build (with namespace + directory).
2. **Assess-first** instruction (finish partial work, don't rewrite).
3. The reading list: [Alchemy resource providers](../alchemy-resource-provider/SKILL.md), [Alchemy typed errors](../alchemy-typed-errors/SKILL.md), the catalog spec, the distilled service module + existing patches, current exemplar resources/tests (account-level CRUD, zone singleton capture-and-restore, observe-before-delete), and the registration files.
4. The **type-check/build ban** (above) — agents never run `tsc`/`pnpm build`; the coordinator owns type-checking.
5. The **speed doctrine** (above) verbatim — agents rediscover unbounded waits otherwise.
6. The **Typed Error Doctrine** hard rule with the patch-regenerate command for *their* service only.
7. Registration discipline for the shared files, including the nested-mergeAll note.
8. Test requirements: `test.provider`, start **and** end with `stack.destroy()`, deterministic names (engine default or constant), out-of-band verification via distilled, typed wait-until-gone, replacement coverage where applicable.
9. Known footguns: `diff` receives `Input<Props>` — narrow with `isResolved(news)` before property access; never `Input<T>` in declared Props; Effect 4 APIs (`Effect.result` + `Result.isSuccess/isFailure`, not `Effect.either`/`effect/Either`); JSON Patches address the Smithy model, so shape IDs are `com.cloudflare.{service}#Name` and member names are wire names (snake_case) — the camelCase TS surface is derived at codegen; fixtures (CSRs, PEMs, JWKS) are generated once and checked in as constants, never at test time.
10. A **structured result schema**: `{ service, resources, testsPassed, testCommand, files, patches (with reasons), skippedTests (with exact errors), notes }` — the coordinator aggregates these into the catalog.


## The convergence loop: nuke → test → census → fix-fleet

Ironing out the AWS suite is an iterative loop, driven by a coordinator, that terminates only when the suite is green AND the account is clean for **two consecutive rounds**. "Green" alone is not the bar — a passing test that leaves cloud resources behind is a provider bug by definition.

Each iteration:

0. **Clean slate** — first run `aws sso login` (the alchemy `testing` profile and the raw `aws` CLI ride the same SSO session; an expired token mid-round breaks the pipeline with auth errors — only escalate to a human if the login doesn't complete automatically). Then `pnpm nuke --yes` (deletes every alchemy-tagged cloud resource; `scripts/nuke.sh` already spares state buckets, SSO roles, and AWS-managed singletons) then `pnpm alchemy state delete Nuke --config ./stacks/nuke.ts --profile testing --recursive`. Never overlap nuke with a running suite. Plain `pnpm clear:state` lacks the profile and dies on expired Cloudflare OAuth; nuke without `--yes` hangs on an interactive confirm in non-interactive shells.
1. **Full suite, bounded** — `pnpm test test/AWS --profile testing`. The runner defaults to `--concurrency 32`; NEVER override it to `unbounded` on a full-suite run: all ~775 files' `beforeAll` deploys start at once, the event loop saturates, and hundreds of fake 0ms `beforeAll TimeoutError` failures drown the real signal (heap is ~8.5 GB regardless of N — the constraint is CPU, not memory). Target ≤10 min wall-clock, hard cap 128; measured 32 → ~21 min clean. The saturation tell is `beforeAll` failures at 0ms; real failures fail slow. If the cap can't reach 10 min, the residual is individual slow files — skipIf-gate them per the speed doctrine.
2. **Leak census** — `pnpm nuke --dry-run` after the suite; diff against the pre-suite baseline. Worklist = **failed services ∪ leaking services** (a service can pass green and still leak). Leave the leaked resources LIVE as forensic evidence for the fix agents; carry-over holdouts that survive repeated nuke passes (stuck deletes) go on the worklist too — their delete path is the bug.
3. **Fix-fleet workflow** — one agent per service on the worklist (account-singleton services — CloudTrail, Config, SecurityHub, GuardDuty, ControlTower, IdentityCenter — run as a sequential chain; everything else fans out). Each agent gets its exact failures, its leak inventory, and this root-cause priority: **provider bug > distilled patch > test fix** — never paper over a provider leak in the test. Each agent runs ONLY its own suite (`timeout 240 pnpm test test/AWS/{Service} --profile testing`), audits its tests for non-deterministic names (rely on PhysicalName auto-naming; random data in message payloads/idempotency tokens is fine), verifies zero orphans from its service via out-of-band distilled list/describe calls, and reports a structured result. Agents never run tsc/build and never run the account-wide nuke.
4. **Gate** — the coordinator runs the one-shot `pnpm exec tsc -b`, fixes cross-cutting fallout, commits the iteration (+ distilled submodule bump when patches were made), and loops back to 0. Terminate on two consecutive iterations of green-suite + census reduced to documented-undeletable residue (e.g. BackupSearch terminal records, Contributor-Insights rules with no delete API, keys in scheduled deletion).

## Multi-agent sessions: the coordinator owns type-checking

When many agents work concurrently (see **The Resource Factory Process**), do NOT let each agent run `pnpm exec tsc -b` — concurrent runs thrash the machine and race on `tsbuildinfo`. Agents never invoke the compiler; the coordinator runs a one-shot `pnpm exec tsc -b` at wave boundaries as the authoritative type check.
