# Prisma Alchemy Completion Audit

Generated: 2026-05-15
Last updated: 2026-05-16

## Objective

Support Prisma in Alchemy using the cloned `pdp-control-plane` and
`project-compute` repositories as references, including:

- Management API coverage for Prisma resources and operations.
- Worker-like Prisma Compute deploy/dev/destroy experience in Alchemy.
- Local dev mode that does not require Prisma credentials.
- Tests that cover the implementation.
- Live deploy/fetch/destroy smoke verification.

## Prompt-To-Artifact Checklist

| Requirement | Artifact / Evidence | Status |
| --- | --- | --- |
| Support Prisma provider in Alchemy | `packages/alchemy/src/Prisma/` | Done |
| Export user-facing `alchemy/Prisma` module | `packages/alchemy/src/Prisma/index.ts`; `packages/alchemy/package.json` export map | Done |
| Runtime import of public Prisma module | `node --input-type=module` import of `alchemy/Prisma` exposes provider/resources/operation helpers | Done |
| Public Prisma export surface is pinned | `packages/alchemy/test/Prisma/PublicSurface.test.ts` asserts the exact 123 runtime exports for resources, provider classes, operation-layer wiring, operations, API/auth errors and constants, the `Postgres` convenience alias, compute archive/build/upload/log helpers, and lifecycle cleanup helpers through both `@/Prisma` and `alchemy/Prisma`; it also pins `./Prisma` and `./Prisma/*` package export-map entries | Done |
| Deep Prisma package exports resolve | `packages/alchemy/test/Prisma/PublicSurface.test.ts` imports `alchemy/Prisma/ComputeApp`, `alchemy/Prisma/Operations`, `alchemy/Prisma/Client`, `alchemy/Prisma/ComputeArchive`, `alchemy/Prisma/Types`, and `alchemy/Prisma/Postgres` through the package export map | Done |
| Product-shaped Prisma Postgres DX | `Prisma.Postgres` is a public alias for the existing `Prisma.Database` resource provider; `PublicSurface.test.ts` proves `Prisma.Postgres === Prisma.Database` and the example README shows the product-shaped path | Done |
| Consumer example can resolve `alchemy/Prisma` | `bun --cwd examples/prisma-compute --print 'import * as Prisma from "alchemy/Prisma"; ...'` reports the public Prisma exports with `ComputeApp`, `providers`, `managementApi`, `runComputeAutoBuild`, and region constants present | Done |
| Register Prisma providers | `packages/alchemy/src/Prisma/Providers.ts`; `packages/alchemy/test/Prisma/Providers.test.ts` verifies every Prisma resource is available through `Prisma.providers()` | Done |
| Direct Management API helper layer | `Prisma.managementApi()` provides `PrismaClient` and its auth registry for helpers such as `Prisma.listProjects()` outside stack lifecycle code; `Providers.test.ts` and a direct `bun --conditions=bun` smoke verify helper access without manually providing `AuthProviders` | Done |
| Prisma region convenience exports | `KNOWN_REGION_IDS` and `REGIONS` exported from `alchemy/Prisma`, matching the cloned `project-compute` SDK constants; `ComputeService.regionId` and `ComputeApp.regionId` use `PrismaRegionId` | Done |
| Cover lifecycle resources | `Project`, `Database`, `Connection`, `Branch`, `ComputeService`, `ComputeVersion`, `EnvironmentVariable`, `SourceRepository`, `ComputeApp` | Done |
| Idempotent resource deletion | `packages/alchemy/test/Prisma/Resources.test.ts` verifies Prisma 404 during delete is treated as already gone for direct resources plus Compute service/version helpers | Done |
| Resilient Compute version delete | `destroyComputeVersion` tries service-scoped delete first, then global `/v1/versions/{id}` delete on non-404 failure, and reports the status at delete time for platform cleanup diagnostics; covered by `ComputeLifecycle.test.ts` | Done |
| Project-level Compute cleanup helper | `destroyComputeProject` discovers all Compute services in a project, destroys their versions/services, then deletes the project; `ComputeApp.live.test.ts` uses it for cleanup-only retries; generated declarations expose named cleanup result types and JSDoc; covered by `ComputeLifecycle.test.ts` | Done |
| Project destroy satisfies Compute cleanup prerequisite | `ProjectProvider.delete` calls `destroyComputeProject` before project deletion so Alchemy handles the control-plane requirement that active Compute versions be stopped/deleted first; covered by `Resources.test.ts` | Done |
| Cover full Management API helper surface | `packages/alchemy/src/Prisma/Operations.ts`; `packages/alchemy/test/Prisma/Operations.test.ts` type-checks that every `PrismaManagementClient` method has a helper and no extra helper exists, then runtime-pins the helper export list and delegation calls | Done |
| Verify against cloned `pdp-control-plane` route inventory | `packages/alchemy/test/Prisma/Client.test.ts` compares 68 method+path routes to `pdp-control-plane/packages/management-api-sdk/src/api.d.ts` when present | Done |
| Verify against mounted control-plane route source | `packages/alchemy/test/Prisma/ManagementCoverage.test.ts` parses `services/management-api/routes/v1.ts`, follows mounted route files, extracts `router.get/post/patch/delete` paths, and confirms the same 68 routes are covered | Done |
| Provide human-readable Prisma route coverage handoff | `PRISMA_MANAGEMENT_API_COVERAGE.md` maps all 68 public Management API routes to lifecycle resources or operation-only helpers and notes admin-route exclusion plus `project-compute` SDK parity | Done |
| Keep internal admin routes out of public Prisma support scope | `packages/alchemy/test/Prisma/ManagementCoverage.test.ts` parses `routes/admin.ts`, verifies the `__admin` routes are protected by `adminAuthentication()`, and confirms `/__admin` is absent from the generated public SDK types | Done |
| Verify Prisma Compute SDK route parity | `packages/alchemy/test/Prisma/ManagementCoverage.test.ts` parses `project-compute/sdk/src/api-client.ts`, pins its 14 deploy/destroy/log-adjacent route calls, and confirms each is inside the Alchemy-covered public Management API route set | Done |
| Classify every Management API route as resource-backed or operation-only | `packages/alchemy/test/Prisma/ManagementCoverage.test.ts` parses the cloned `api.d.ts` and verifies all 68 routes are accounted for by lifecycle resources or explicit operation-only helpers | Done |
| Verify Prisma-specific API body/query shapes | `packages/alchemy/test/Prisma/Client.test.ts` asserts request bodies for project transfer, database restore/create, compute service create/promote, compute version create/fork, env var create/update, and source repository link | Done |
| Retry transient Prisma API failures without long wall-clock stalls | `packages/alchemy/src/Prisma/Client.ts` uses an explicit `100 millis` exponential retry schedule for HTTP 408/429/5xx; `packages/alchemy/test/Prisma/Client.test.ts` proves a destructive DELETE retries two HTTP 500 responses and then succeeds under `TestClock` | Done |
| Keep Compute service/version creation on scoped typed Prisma client routes | `ComputeService` and `ComputeApp` call `listProjectComputeServices` / `createProjectComputeService`; `ComputeVersion` and `ComputeApp` call `createServiceComputeVersion` so the resource paths match the working `project-compute` SDK deploy path and avoid fallback `as any` API calls in the live Compute path | Done |
| Worker-like deploy resource | `packages/alchemy/src/Prisma/ComputeApp.ts` | Done |
| Prisma Compute SDK-style auto-build DX | `packages/alchemy/src/Prisma/ComputeBuild.ts`; `ComputeApp.build: "auto"` supports Next.js, Nuxt, Astro, TanStack Start, and Bun detection; `ComputeBuild.test.ts` covers Bun build output, local Next.js CLI artifact shaping, and nested Next.js standalone entrypoints in monorepos; `ComputeApp.test.ts` verifies auto-build uploads and framework default port mapping through `ComputeApp` | Done |
| Prisma Compute artifact archive parity | `ComputeArchive.ts` creates the `compute.manifest.json` + `bundle/` tar.gz format, dereferences safe file and directory symlinks, rejects escaping file and directory symlinks, and preserves executable file modes like `project-compute/sdk/src/archive.ts`; `ComputeArchive.test.ts` covers those cases | Done |
| Match official `project-compute` deploy cleanup behavior | `ComputeApp` now best-effort stops/deletes a newly created version if promotion fails, matching `project-compute/sdk/src/compute-client.ts`; covered by `ComputeApp.test.ts` | Done |
| Idempotent ComputeApp destroy when env state is already absent | `ComputeApp.delete` treats 404 while looking up managed env vars as already cleaned and still proceeds to Compute service cleanup; covered by `ComputeApp.test.ts` | Done |
| Align Compute env var semantics with current control-plane contract | `pdp-control-plane/packages/management-api-sdk/src/api.d.ts` says Compute version create resolves env vars from Branch and clients manage them via `/v1/environment-variables`; Alchemy follows that through `ComputeApp.env` / `EnvironmentVariable` and exact client body tests omit `envVars` from create-version payloads | Done |
| Redacted Compute env values stay out of resource outputs | `ComputeApp.test.ts` verifies redacted env values are sent only to Prisma's environment-variable API and do not appear in `ComputeApp` outputs while still contributing to version-change hashing | Done |
| Worker-like local dev | `ComputeAppDevProvider`; `examples/prisma-compute` dev smoke hit `/` and `/health` on `localhost:8787`; `examples/prisma-nextjs` dev smoke hit `/` and `/api/health` on `localhost:3000`; `ComputeApp.dev.test.ts` verifies dev command env and destroy stops the local process | Done |
| Complete commented Next.js example | `examples/prisma-nextjs` includes a Next.js app, `Prisma.Project`, `Prisma.Branch`, `Prisma.Postgres`, `Prisma.Connection`, standalone `Prisma.EnvironmentVariable`, `Prisma.ComputeApp build: "auto"`, local `alchemy dev` env, README, and comments explaining deploy/dev/destroy; typecheck, Next build, auto-build entrypoint, and local dev smoke are verified | Done |
| Deploy/fetch live smoke | Live run created Prisma project/service/version, uploaded/started/promoted app, and reached URL | Done |
| Destroy live smoke | Blocked by Prisma Compute API returning HTTP 500 deleting a stopped version | Blocked upstream |
| Live smoke failure diagnostics | `packages/alchemy/test/Prisma/ComputeApp.live.test.ts` includes project/service/version IDs, a cleanup retry command, and a `PRISMA_COMPUTE_PLATFORM_BUGS.md` pointer if destroy fails after deploy | Done |
| Live smoke gating | `ALCHEMY_RUN_LIVE_PRISMA_TESTS=false bun vitest run packages/alchemy/test/Prisma/ComputeApp.live.test.ts` skips cleanly without credentials; current shell has no `PRISMA_SERVICE_TOKEN` / `PRISMA_API_TOKEN` | Done |
| Existing stranded resource cleanup retry | `ComputeApp.live.test.ts` includes opt-in `ALCHEMY_RUN_LIVE_PRISMA_CLEANUP=true` cleanup from `PRISMA_CLEANUP_PROJECT_ID`, with optional service/version IDs for checks/direct retry; `examples/prisma-compute` exposes `bun run cleanup:live` and `bun run cleanup:live:profile`; docs and bug report include the command | Done |
| Public cleanup workaround investigation | `PRISMA_COMPUTE_PLATFORM_BUGS.md` documents that the cloned `project-compute` SDK/CLI use the same stop-then-delete version flow and the cloned control-plane admin API does not expose a compute-version force-delete route | No workaround found |
| Compute log tail dependency wiring | `ws` is a dev dependency for tests and optional peer dependency for runtime log tailing | Done |
| Prisma auth/env compatibility | `AuthProvider.test.ts` covers `PRISMA_SERVICE_TOKEN`, `PRISMA_API_TOKEN`, precedence, stored credentials, and missing-token errors; `PrismaEnvironment.test.ts` covers `PRISMA_API_URL` / `PRISMA_MANAGEMENT_API_URL` aliases and precedence | Done |
| Document Prisma platform bugs | `PRISMA_COMPUTE_PLATFORM_BUGS.md` includes live stuck IDs, repro curls, observed responses, source-level control-plane analysis, and a concrete `deleteComputeVersion` regression-test sketch for the Prisma team | Done |
| Warn example users about live destroy blocker | `examples/prisma-compute/README.md` documents the stopped-version delete HTTP 500 issue and points to `PRISMA_COMPUTE_PLATFORM_BUGS.md` | Done |
| Avoid persisting service token | Repeated token scans clean; no token prefix hits on 2026-05-16 | Done |
| Prisma provider source conventions are enforced | `packages/alchemy/test/Prisma/SourceConventions.test.ts` scans `packages/alchemy/src/Prisma` for forbidden raw fs/path/os/pathe imports, async/await, `Effect.orDie`, old create/update lifecycle handlers, explicit `output === undefined` / `output !== undefined` reconciler branches, bare `process.cwd()`, explicit `any`, and missing Prisma resource docs structure | Done |
| Build example apps | `bun run --cwd examples/prisma-compute build`; `bun run --cwd examples/prisma-nextjs build` | Done |
| Build Alchemy package | `bun run --filter alchemy build` | Done |
| Build all packages through monorepo package build gate | `bun run build:packages` completed successfully after the project-level cleanup helper; same existing Cloudflare `cloudflare:workers` external warning only | Done |
| Typecheck package/tests | `bun tsc -b packages/alchemy/tsconfig.json packages/alchemy/tsconfig.test.json --pretty false` | Done |
| Unit/integration tests | `bun vitest run packages/alchemy/test/Prisma` -> 105 passed, 2 skipped | Done |
| Public docs source + generation | Reviewable source JSDoc in all 9 Prisma resource files includes `@section` / `@example`; `bun generate:api-reference` discovered 489 source files and wrote 175 provider pages, including ignored generated output for all 9 Prisma provider pages under `website/src/content/docs/providers/Prisma/`; `SourceConventions.test.ts` now enforces Prisma resource docs-readiness | Done |
| AGENTS.md Effect/resource constraints | `SourceConventions.test.ts` scans `packages/alchemy/src/Prisma` for forbidden raw filesystem/path/process usage, `async`/`await`, explicit `any`, split create/update lifecycle handlers, explicit output-undefined create/update branches, lifecycle `Effect.orDie`, and missing Prisma resource docs structure | Done |

## Current Verification Snapshot

Latest green local gates rerun on 2026-05-16:

```sh
bun vitest run packages/alchemy/test/Prisma
# 16 test files passed, 1 skipped; 105 tests passed, 2 skipped

bun vitest run packages/alchemy/test/Prisma/ComputeApp.test.ts -t "redacted env"
# 1 test file passed; 1 test passed, proving redacted ComputeApp env values are not exposed in resource outputs

bun vitest run packages/alchemy/test/Prisma/SourceConventions.test.ts
# 1 test file passed; 2 tests passed, enforcing Effect-style source conventions, no explicit `any`, and generated-doc readiness for Prisma resources

bun vitest run packages/alchemy/test/Prisma/Resources.test.ts packages/alchemy/test/Prisma/Client.test.ts packages/alchemy/test/Prisma/ComputeVersion.test.ts packages/alchemy/test/Prisma/ComputeApp.test.ts
# 4 test files passed; 43 tests passed, covering typed scoped Compute service and Compute version route cleanup

bun vitest run packages/alchemy/test/Prisma/ManagementCoverage.test.ts
# 1 test file passed; 6 tests passed, including route classification against cloned pdp-control-plane api.d.ts, mounted route-source inventory, admin-route exclusion from the public SDK surface, project-compute SDK route parity, and PRISMA_MANAGEMENT_API_COVERAGE.md route-sync enforcement

ALCHEMY_RUN_LIVE_PRISMA_TESTS=false bun vitest run packages/alchemy/test/Prisma/ComputeApp.live.test.ts
# 1 test file skipped; 2 tests skipped, covering deploy/fetch/destroy smoke and cleanup-only retry gating

node -e 'console.log(JSON.stringify({hasService: !!process.env.PRISMA_SERVICE_TOKEN, hasApi: !!process.env.PRISMA_API_TOKEN}))'
# {"hasService":false,"hasApi":false}

bun vitest run packages/alchemy/test/Prisma/PublicSurface.test.ts
# 1 test file passed; 4 tests passed, covering the exact public alchemy/Prisma runtime export surface, deep package exports, and package export-map entries

bun vitest run packages/alchemy/test/Prisma/ComputeBuild.test.ts
# 1 test file passed; 3 tests passed, covering Bun auto-build, local Next.js CLI artifact shaping, and nested Next.js standalone entrypoints in monorepos

bun vitest run packages/alchemy/test/Prisma/ComputeArchive.test.ts
# 1 test file passed; 8 tests passed, covering manifest/bundle archive shape, file and directory symlink safety, and executable mode preservation

bun vitest run packages/alchemy/test/Prisma/ComputeApp.test.ts packages/alchemy/test/Prisma/ComputeBuild.test.ts
# 2 test files passed; 19 tests passed, including ComputeApp auto-build upload integration and framework default port mapping

bun vitest run packages/alchemy/test/Prisma/AuthProvider.test.ts packages/alchemy/test/Prisma/PrismaEnvironment.test.ts
# 2 test files passed; 12 tests passed, including env token/API URL alias precedence

bun vitest run packages/alchemy/test/Prisma/Providers.test.ts
# 1 test file passed; 3 tests passed, including provider collection registration, tokenless dev provider selection, and managementApi() operation helper wiring

bun --cwd packages/alchemy --conditions=bun -e 'import * as Prisma from "./src/Prisma/index.ts"; import * as Effect from "effect/Effect"; import * as ConfigProvider from "effect/ConfigProvider"; const program = Effect.gen(function*(){ const client = yield* Prisma.PrismaClient; console.log(typeof client.listProjects); }).pipe(Effect.provide(Prisma.managementApi()), Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ PRISMA_SERVICE_TOKEN: "test-token" })))); await Effect.runPromise(program);'
# function, proving Prisma.managementApi() does not require callers to provide AuthProviders manually

bun vitest run packages/alchemy/test/Prisma/ComputeApp.test.ts
# 1 test file passed; 19 tests passed, including cleanup of a newly created version when promotion fails, idempotent env cleanup on destroy, and ComputeApp auto-build upload/default-port integration

bun vitest run packages/alchemy/test/Prisma/ComputeLifecycle.test.ts
# 1 test file passed; 12 tests passed, including fallback from service-scoped version delete to global version delete, post-stop status reporting on delete failure, and project-level Compute cleanup

bun vitest run packages/alchemy/test/Prisma/ComputeApp.dev.test.ts
# 1 test file passed; 4 tests passed, including local process cleanup on destroy

bun vitest run packages/alchemy/test/Prisma/ComputeVersion.test.ts
# 1 test file passed; 5 tests passed, including no replacement for byte-equivalent artifacts

bun vitest run packages/alchemy/test/Prisma/ComputeApp.test.ts
# 1 test file passed; 17 tests passed, including explicit skipCodeUpload env updates and auto-build upload/default-port integration

bun vitest run packages/alchemy/test/Prisma/Client.test.ts
# 1 test file passed; 10 tests passed, including exact Management API body/query shape checks, cursor pagination, and transient DELETE retry coverage

bun vitest run packages/alchemy/test/Prisma/Resources.test.ts
# 1 test file passed; 12 tests passed, including idempotent delete-on-404 coverage

bun tsc -b packages/alchemy/tsconfig.json packages/alchemy/tsconfig.test.json --pretty false
# passed

bun run --filter alchemy build
# passed; existing Cloudflare external warning only

bun run build:packages
# passed; existing Cloudflare external warning only

bun run --cwd examples/prisma-compute build
# passed

node --input-type=module -e 'await import("alchemy/Prisma")'
# passed

node --input-type=module -e 'const Prisma = await import("alchemy/Prisma"); console.log(Object.keys(Prisma).length, Boolean(Prisma.KNOWN_REGION_IDS), Boolean(Prisma.REGIONS), Prisma.KNOWN_REGION_IDS[0])'
# 123 true true us-east-1

bun generate:api-reference
# passed; discovered 489 source files and wrote generated provider docs under ignored website/src/content/docs/providers

find website/src/content/docs/providers/Prisma -type f | sort
# Branch.md, ComputeApp.md, ComputeService.md, ComputeVersion.md, Connection.md, Database.md, EnvironmentVariable.md, Project.md, SourceRepository.md

rg -n "export const (Project|Database|Connection|Branch|ComputeService|ComputeVersion|EnvironmentVariable|SourceRepository|ComputeApp)|@section|@example" packages/alchemy/src/Prisma/*.ts
# all 9 Prisma resources have generated-doc JSDoc with examples in source

git diff --check
# clean

token-prefix scan across source/docs, excluding reference clones
# no hits

Post-cleanup-script edit verification on 2026-05-16:

bun vitest run packages/alchemy/test/Prisma
# 16 test files passed, 1 skipped; 104 tests passed, 2 skipped

bun run --cwd examples/prisma-compute build
# passed

ALCHEMY_RUN_LIVE_PRISMA_TESTS=false bun vitest run packages/alchemy/test/Prisma/ComputeApp.live.test.ts
# 1 test file skipped; 2 tests skipped

node -e 'const p=require("./examples/prisma-compute/package.json"); console.log(p.scripts["cleanup:live:profile"] || "missing")'
# cd ../.. && ALCHEMY_RUN_LIVE_PRISMA_CLEANUP=true ALCHEMY_RUN_LIVE_PRISMA_WITH_PROFILE=true bun vitest run packages/alchemy/test/Prisma/ComputeApp.live.test.ts

git diff --check
# clean

token-prefix scan across source/docs, excluding reference clones
# no hits

generated artifact scan
# no leftover .tgz or .tsbuildinfo files

Post-Prisma.Postgres alias verification on 2026-05-16:

bun tsc -b packages/alchemy/tsconfig.json packages/alchemy/tsconfig.test.json --pretty false
# passed

bun vitest run packages/alchemy/test/Prisma/PublicSurface.test.ts packages/alchemy/test/Prisma/SourceConventions.test.ts
# 2 test files passed; 6 tests passed

bun vitest run packages/alchemy/test/Prisma
# 16 test files passed, 1 skipped; 104 tests passed, 2 skipped

node --input-type=module -e 'const Prisma = await import("alchemy/Prisma"); console.log(Object.keys(Prisma).length, Prisma.Postgres === Prisma.Database, Prisma.Postgres.Type)'
# 123 true Prisma.Database

git diff --check
# clean

token-prefix scan across source/docs, excluding reference clones
# no hits

generated artifact scan
# no leftover .tgz or .tsbuildinfo files

Post-Next.js example verification on 2026-05-16:

bun install
# completed and updated bun.lock for Next.js/React workspace dependencies

bun run --cwd examples/prisma-nextjs typecheck
# passed

bun run --cwd examples/prisma-nextjs build
# Next.js 16.2.6 build passed

bun --conditions=bun -e 'import * as Effect from "effect/Effect"; import { runComputeAutoBuild } from "./packages/alchemy/src/Prisma/ComputeBuild.ts"; import { PlatformServices } from "./packages/alchemy/src/Util/PlatformServices.ts"; const program = Effect.gen(function*(){ const artifact = yield* runComputeAutoBuild({ appPath: "examples/prisma-nextjs", framework: "nextjs" }); console.log(artifact.entrypoint); yield* artifact.cleanup; }); await Effect.runPromise(Effect.scoped(program).pipe(Effect.provide(PlatformServices)));'
# examples/prisma-nextjs/server.js

bun run --cwd examples/prisma-nextjs dev
curl -fsS http://localhost:3000/api/health
# {"ok":true,"hasDatabaseUrl":true,"hasDirectUrl":true,"projectId":"local-project","databaseId":"local-database","connectionId":"local-connection","featureFlag":"local-dev","sharedFlag":"local-project-level"}

bun vitest run packages/alchemy/test/Prisma
# 16 test files passed, 1 skipped; 105 tests passed, 2 skipped

bun tsc -b packages/alchemy/tsconfig.json packages/alchemy/tsconfig.test.json examples/prisma-nextjs/tsconfig.json --pretty false
# passed

generated artifact scan
# no leftover .next, .alchemy, .tgz, or .tsbuildinfo files
```

Additional audit on 2026-05-16:

```sh
rg -n "compute|version|delete|force" pdp-control-plane/services/management-api/routes/admin.ts
# no public/admin compute-version force-delete route found

rg -n "destroyVersion|deleteVersion|destroyService|deleteService" project-compute/sdk/src project-compute/cli/src/commands
# project-compute SDK/CLI uses get/stop/delete version, then delete service

node --input-type=module - <<'NODE'
# parsed pdp-control-plane/packages/management-api-sdk/src/api.d.ts
# route-count=68
NODE

node -e 'process.exit(process.env.PRISMA_SERVICE_TOKEN || process.env.PRISMA_API_TOKEN ? 0 : 1)'
# exit 1, so live cleanup was not retried from the current shell environment

ALCHEMY_RUN_LIVE_PRISMA_CLEANUP=true \
ALCHEMY_RUN_LIVE_PRISMA_WITH_PROFILE=true \
PRISMA_CLEANUP_PROJECT_ID=proj_cmp7dc5wu1tv51af8j07x4b76 \
PRISMA_CLEANUP_COMPUTE_SERVICE_ID=cps_cmp7dc6mu1tv71af83lxuatvp \
PRISMA_CLEANUP_COMPUTE_VERSION_ID=cpv_cmp7dc8h91tvd1af8sytxctbs \
bun vitest run packages/alchemy/test/Prisma/ComputeApp.live.test.ts -t 'live cleans up an existing Prisma Compute project/service from configured credentials'
# failed before any Prisma API call:
# Prisma env credentials not found. Set PRISMA_SERVICE_TOKEN or PRISMA_API_TOKEN.
# This machine's active profile is configured for env auth, not stored Prisma credentials.
```

Latest local dev smoke rerun on 2026-05-16:

```sh
bun run --cwd examples/prisma-compute dev
curl -sS http://localhost:8787/
# hello from alchemy dev
curl -sS http://localhost:8787/health
# {"ok":true}
```

After `Ctrl-C`, the dev process exits with code 0 and port `8787` is clear.
The shutdown path currently prints a reproducible Bun/internal watcher message:
`Internal error: directory mismatch for directory ".../packages/alchemy/tsconfig.json"`.
That local-dev wart is documented in `PRISMA_COMPUTE_PLATFORM_BUGS.md`; it is
separate from the Prisma Compute platform destroy blocker.

Latest live cleanup result for the stuck smoke resource:

```text
GET /v1/versions/cpv_cmp7dc8h91tvd1af8sytxctbs -> 200 stopped
DELETE /v1/versions/cpv_cmp7dc8h91tvd1af8sytxctbs -> 500 Internal Server Error
DELETE /v1/compute-services/versions/cpv_cmp7dc8h91tvd1af8sytxctbs -> 500 Internal Server Error
DELETE /v1/compute-services/cps_cmp7dc6mu1tv71af83lxuatvp -> 409 active compute versions exist
DELETE /v1/projects/proj_cmp7dc5wu1tv51af8j07x4b76 -> 409 active compute versions exist
```

## Completion Decision

Do not mark the goal complete yet.

Alchemy-side implementation, dev, build, typecheck, tests, and live deploy/fetch
are verified. The remaining required gate is live destroy. That gate is blocked
by a Prisma Compute platform issue: stopped compute version deletion returns
HTTP 500, so service and project deletion remain blocked.

The goal can be marked complete only after Prisma Compute deletion is fixed or a
supported cleanup endpoint/workaround is provided, and the live smoke passes:

```sh
ALCHEMY_RUN_LIVE_PRISMA_TESTS=true \
PRISMA_SERVICE_TOKEN=... \
bun vitest run packages/alchemy/test/Prisma/ComputeApp.live.test.ts
```
