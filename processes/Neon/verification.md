# Neon backend implementation verification

Integration snapshot, 2026-09-17. All 38 required source contracts are present, including 13 Website constructors. Source coverage is not acceptance: two complete scoped, leak-free rounds have not passed.

## Coordinator verification

- Distilled companion: https://github.com/alchemy-run/distilled/pull/617. Latest revision `ed08017b3` includes the unstructured REST-XML server-error correction and strictly checked parser assertions.
- Published SDK revision: the combined core, Neon, spec-fetcher and REST-XML run passed 372 tests across 11 files, with 725 assertions and no failures. Regeneration retains 163 operations and 748 shapes. Source/scripts and shared-core checks passed.
- REST-XML follow-up: 34 tests, 95 assertions passed. Code-less HTTP 5xx responses become the existing retryable `InternalError`, without retaining their bodies. Recognized codes and malformed 4xx behavior are preserved. The original Neon storage PUT HTTP 500 cause remains unknown.
- Final focused Alchemy regression run: 97 tests across 11 files passed, including typed objects, Effect LanguageModel, Function cancellation/ZIP checks, Website artifact safety, constructor props, and provider composition.
- AI example: 17 tests and 55 assertions passed, including native/Effect request validation, explicit inference gating, request-scoped streaming, sanitization, and cancellation.
- Full workspace `pnpm exec tsc -b` passed after restoring declarations removed by a JavaScript-only frontend bundler invocation. The package's normal build already restores those declarations.
- Frontend framework regressions: 111 tests across 20 files passed earlier, including actual Vite/Astro/Next builds and Fetch invocation. This is not the full live Website matrix.
- JSDoc validation, generated API references, and website `docs:check` passed. Documentation browser checks traversed all 19 Neon overview/tutorial/frontend routes at desktop 1440x1000 and mobile 390x844, including opening the mobile menu, following navigation links, and visiting an API reference and returning. No overflow or browser page errors were observed.

## Focused live verification

These are separate completed runs, not a complete combined acceptance suite.

| Area | Evidence | Limits |
| --- | --- | --- |
| Project, Branch, SQL bindings | 20 earlier live cases; two additional explicit-name/schema-only replacement cases passed | Final combined rerun and census remain open |
| Auth, OAuth, Data API, AI Gateway endpoint discovery | Nine earlier live cases; three recovery/ownership regressions passed | DNS, SMTP and external OAuth authorization require prerequisites |
| Storage | Combined five-case run passed for native and Effect Functions, RPC-backed local Functions, Workers and Lambda; eight consecutive typed writes and ordinary cleanup | Inherited-bucket tag management is rejected by the current service |
| Function forms and events | Native, Hono, Effect constructor/class/Layer, local mode, remote opt-out, storage event and minute-cron delivery passed | Live cancellation and update propagation remain failing |
| Function logs | Two focused live runs passed; final run checked sibling isolation, with all five stack resources destroyed | Not evidence that runtime update propagation works |
| Portable Vocs | Fresh artifact and actual example deployment passed; live desktop/mobile counter and guide navigation, JSON GET/HEAD and llms.txt passed; all four example resources normally destroyed | Historical temporary-stack sensitive trace failure was not reproduced; sanitized path diagnostics and nine safety regressions added without weakening rejection |
| Portable Next | Corrected request-origin initialization; actual build regressions and Linux ARM64 Node 24 artifact desktop/mobile redirects, counters, greeting requests, server actions, refresh persistence, assets, SSE and 404 checks passed | Live deployment still failed with FunctionDeploymentFailed; local portability is not live deployment acceptance |
| Tutorial recovery | Parent and preview normal destroy succeeded; SDK verified project and branch absent | Full authenticated native/Effect browser acceptance and preview adoption remain incomplete |

## Confirmed failures and prerequisites

### Function update propagation

Independent SDK and Alchemy probes observed new active deployment IDs while the Function URL continued serving old code and environment. Config-only updates and complete replacement ZIPs both exhibited this within bounded polling. No verified workaround or upstream cause is established. Metadata acceptance is not runtime update acceptance.

### Live request finalizers

Direct abort/body-cancellation regressions pass after correcting bridge scope closure. Live network cancellation still reported an active request without its finalizer. WebSocket echo passed but the finalizer was absent after explicit close. Three bounded attempts were exhausted; the failing tests remain visible.

### AI entitlement

The current public OpenAPI (122 paths) and official config runtime expose AI Gateway discovery but no enablement or credit-purchase operation. Two authorized eight-token inference probes returned HTTP 403 with `ai gateway not enabled for account`; both stacks were destroyed. No credits were purchased and no account plan was changed. Do not repeat inference until entitlement changes.

### Website acceptance

All 13 constructors and examples exist. The full 13-framework live matrix has not passed. Native runtime checks target Linux ARM64/glibc per the official Neon config runtime; ELF header validation alone does not establish Node addon ABI or framework behavior. Next's request origin is now initialized from each Fetch request before invoking its full custom-server router, rather than rewriting redirect responses. Three real framework build tests passed, including concurrent origin/port/protocol variants and external redirects. The corrected Next artifact passed local production browser interactions; the actual Vocs example passed live browser interactions and cleanup. The separate live Next deployment failure remains.

### Cleanup

Parent/preview tutorial stacks were recovered through ordinary lifecycle operations. A prior scratch test discarded its in-memory state while leaving project `spring-term-76599638`, branch `br-green-frog-b53f8s5d`, a Function, an enabled storage trigger, and a bucket. Ordinary lifecycle recovery cannot proceed without retained state. No ownership bypass, adoption, reconstructed state, direct API deletion, or account-wide nuke was used to hide this leak. The final bounded read-only census at 2026-09-18 00:01:55 UTC found exactly two visible projects: that tutorial scratch project and `fragrant-fog-27766379`, the earlier interrupted Next feasibility project. The latter has its default branch/endpoint/database/role but no Functions, storage, triggers, domains or Auth. Its historical destroy refused ownership, and no recovery state remains. No additional active Website projects were visible. Zero leaks is not claimed; cleanup needs an explicitly authorized recovery path.

## Reproduction

Run from the Alchemy root:

```sh
pnpm --config.verify-deps-before-run=false exec tsc -b
pnpm --config.verify-deps-before-run=false docs:check-jsdoc
pnpm --config.verify-deps-before-run=false docs:gen
pnpm --config.verify-deps-before-run=false --dir website run docs:check
timeout 240 pnpm --config.verify-deps-before-run=false test test/Neon/<suite>.test.ts --profile testing --retry 0 --timeout 120000
```

From `submodules/distilled`:

```sh
timeout 240 bun test packages/core/src packages/neon/src/backend.test.ts packages/neon/src/backend.types.test.ts stacks/distilled-submodules/spec-repos/neon/fetch-specs.test.ts --timeout 90000
timeout 240 bun test packages/aws/src/client/response-parser.test.ts --timeout 90000
```

Both companion PRs must remain draft while the acceptance and cleanup requirements above are incomplete.
