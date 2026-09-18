# Neon backend implementation verification

Integration snapshot, 2026-09-18. All 38 required source contracts are present, including 13 Website constructors. Source coverage is not acceptance: two complete scoped, leak-free rounds have not passed.

## Current acceptance rerun

All 295 registered Neon cases have a result across bounded runs: **270 passed, 18 failed, 7 gated/TODO**. This is a reconciled per-test result, not one uninterrupted green run. The initial combined run hit the 240-second limit; subsequent groups completed the remaining files. The seven unrun cases require designated governance fixtures. Inherited bucket configuration now passes ungated; the explicitly enabled write-only credential probe failed, accounting for the additional failure rather than hiding it behind its default gate. Both opt-in Linux artifact tests and both fresh-artifact live tests were explicitly enabled.

- Paid AI is now verified. After the user corrected a declined payment, `gpt-oss-20b` passed generation, streaming, tool execution and structured output through both injected and explicit credentials. Ordinary cleanup passed. `gpt-5-mini` remains separately gated with `model requires a verified account`; authenticated `/v1/models` discovery identifies enabled models. Basic Qwen generation passed, but that model did not pass the same tool-call case.
- A disk-full interruption exposed Data API recovery of an incomplete, never-created branch reference. The provider now treats that identity as absent, matching Auth/Function recovery. All five Data API cases passed, including normal recovery and destruction of the interrupted live stack.
- The local Function and storage tests passed with Neon CLI 2.45.0 on PATH. Worker/Lambda storage cases passed after allowing a bounded 24-second initial edge-propagation window; the preceding combined run had hit a fresh workers.dev 404 after eight seconds.
- All 13 live Website lifecycle cases executed and passed initial deployment, desktop/mobile interaction checks and the initial no-op. All 13 then failed unchanged-content assertions after an accepted update. Post-update no-op was not reached. A separate static-site feasibility case also fails update serving.
- SvelteKit's Neon target now resolves extensionless prerendered HTML routes. Production-artifact GET/HEAD `/about` and live desktop/mobile navigation/reload passed after the fix.
- Fresh-artifact tests now build their inputs instead of assuming old example output directories exist. The final artifact run passed all 33 cases, including Next and Vocs Linux ARM64/glibc Node 24 checks and both fresh live deployments. The separate Next deployment feasibility case also passed.
- Neon deployment failures now retain the API's human-readable error. Next's initial `build failed: mksquashfs build failed (HTTP 413): source_too_large` rejection exposed redundant Sharp native libraries added for a metadata-only trace. Packaging now stages native dependencies only for traced Sharp JavaScript. The example ZIP shrank from 35.970 to 28.015 MiB and expanded files from 115.259 to 97.319 MiB, retaining all traced runtime files. A regression covers metadata-only traces; the fixed live Next deployment and desktop/mobile counter, greeting and server-action flows passed. The numeric upstream size limit is not documented.
- Function update diagnostics submitted different ZIPs under an unchanged function identity and URL. Neon reported the new deployment active/completed, but stable-URL responses mixed old and new code even across fresh curl connections; query strings, cache-control headers and connection closure did not reliably help. A proposed artifact-hash environment change also failed and was reverted. The precise server-side routing/cache cause remains unestablished. The regression now checks 16 responses rather than accepting one fresh response.
- A native lifecycle handler bypassing Alchemy's bridge reproduced the disconnect failures: WebSocket echo and client close succeeded, but the server-side close marker was absent; aborted streams produced neither request-abort nor stream-cancel markers, with or without SSE headers. The original native upgrade Response remains unchanged. Seven direct/ordinary-runtime cases passed, while the two durable-finalizer cases still failed. No speculative bridge workaround was retained.
- Inherited bucket configuration is fixed and its gate removed. Neon exposes inherited data before child-local configuration exists; after a typed tagging `NoSuchBucket`, the provider creates that configuration on the target child branch and retries tagging. The live lifecycle passed inherited reads, child-local writes/deletes, tags/CORS updates, unchanged parent configuration/data, ownership checks and cleanup.
- The separately enabled write-only credential probe still returned typed `AccessDeniedException: Access Denied.` for `ListBuckets`. Its capability gate remains, with no permission broadening; the test-owned project was independently confirmed absent.

The example's 46 offline tests and real upload-event/SQL/download lifecycle passed. The Effect upload failure is fixed: the upload POST succeeded, but the subsequent populated listing could not JSON-encode native Postgres `bigint` sizes. The API now serializes byte counts losslessly and normalizes epoch-millisecond timestamps; a live query reproduced the original JSON failure and four regressions cover serialization. Complete uninstrumented Effect browser flows passed on desktop/mobile: signup, listing/settings, upload, event-backed ready state, exact signed download, reload persistence, signout/sign-in and negative requests. Native browser acceptance had already passed.

Preview's first-apply Auth failure came from the engine skipping ownership discovery while the cloned branch identity was unresolved. Deferred apply-time ownership discovery now honors the resource-scoped policy. The actual preview application passed first deployment, both live isolation tests and full desktop/mobile upload/download flows. Tests verified disabled inherited triggers, the explicit new trigger, no inherited domains, child-only writes and unchanged parent data/configuration. After normal preview destruction, independent API/SQL checks confirmed child absence and preserved parent Auth/uploads; the parent then passed both full browser flows again. Normal parent destruction and independent project-absence verification also passed. Interruption regressions reproduce and fix lost resolved identity after refused adoption, accidental recovery of a renamed predecessor, and exclusion loss through replacement/garbage-collection checkpoints. Refusal persists resolved properties without foreign attributes; the renamed-resource exclusion survives retries, replacements and deletion recovery. Auth's provider ownership guards remain unchanged.

The final account census found five residual test projects (Bucket, DataApi, Connect, StorageHttp and Branch cases). The authorized Neon-only nuke deleted those five projects and five branches in one pass. A subsequent census found a newly created `NeonHostContainerStack` project belonging to a concurrently running Container suite in another worktree; destructive cleanup stopped rather than deleting that active test's resources. Once that suite exited, a read-only census confirmed zero projects and zero private endpoints. Follow-up debugging uses isolated owned projects with normal destruction and independent absence checks, not account-wide cleanup. This run is not a leak-free acceptance round.

Final integrated verification passed **403 tests** across the complete Plan, Apply, provider-mode, AuthOwnership and Bucket suites, including real Auth/bucket lifecycles. The example passed **46 offline tests**. A separate deployed Function request-isolation check passed and its cleanup independently confirmed both Functions and their project absent. Independent review found no remaining ownership-safety findings in the changes.

Workspace type checking, scoped formatting, JSDoc validation, API-reference generation and the documentation build passed. Browser checks exercised the updated upload-serialization tutorial, preview guide and generated Bucket reference at desktop 1440×1000 and mobile 390×844, including tutorial navigation, code copying, heading anchors and back navigation, with no page errors or horizontal overflow. Earlier checks also covered the Next guide and reference.

An exploratory engine test exposed a separate preexisting cleanup defect: destroying an interrupted `replacing` row can discard the prior generation's `old` chain without deleting that known generation. Source comparison confirmed the behavior exists in the published baseline and is not caused by the new ownership exclusion; it remains unfixed. The exclusion deliberately prevents ambiguous lookups from deleting a renamed predecessor, while known-attribute deletion remains enabled.

Two complete green, leak-free acceptance rounds remain blocked by the live failures. The following sections retain earlier verification history; their earlier AI-entitlement, missing-matrix and initial Next deployment-failure statements are superseded by this rerun.

## Coordinator verification

- Distilled companion: https://github.com/alchemy-run/distilled/pull/617. Latest revision `5661366be` adds API-key secret redaction alongside the existing unstructured REST-XML server-error correction and strictly checked parser assertions.
- Before the governance additions, the combined core, Neon, spec-fetcher and REST-XML run passed 372 tests across 11 files, with 725 assertions and no failures. Regeneration retains 163 operations and 748 shapes. Source/scripts and shared-core checks passed.
- REST-XML follow-up: 34 tests, 95 assertions passed. Code-less HTTP 5xx responses become the existing retryable `InternalError`, without retaining their bodies. Recognized codes and malformed 4xx behavior are preserved. The original Neon storage PUT HTTP 500 cause remains unknown.
- Final focused Alchemy regression run: 97 tests across 11 files passed, including typed objects, Effect LanguageModel, Function cancellation/ZIP checks, Website artifact safety, constructor props, and provider composition.
- AI example: 17 tests and 55 assertions passed, including native/Effect request validation, explicit inference gating, request-scoped streaming, sanitization, and cancellation.
- Full workspace `pnpm exec tsc -b` passed after restoring declarations removed by a JavaScript-only frontend bundler invocation. The package's normal build already restores those declarations.
- Frontend framework regressions: 111 tests across 20 files passed earlier. After integrating current main and repairing merged dependency snapshots, all 72 core tests across nine files passed, including actual Vite/Astro/Next builds and Fetch invocation; the 97 focused Alchemy tests and workspace typecheck also passed again. This is not the full live Website matrix.
- JSDoc validation, generated API references, and website `docs:check` passed. Documentation browser checks traversed all 19 Neon overview/tutorial/frontend routes at desktop 1440x1000 and mobile 390x844, including opening the mobile menu, following navigation links, and visiting an API reference and returning. No overflow or browser page errors were observed.

## Organization governance additions

Six additional source resources are registered: `OrganizationApiKey`, `OrganizationMemberRole`, `ProjectMemberRole`, `OrganizationSpendingLimit`, `OrganizationVPCEndpoint`, and `ProjectVPCEndpoint`.

- The combined six-file governance run passed **31 non-live safety tests**, with **seven live fixture cases gated** and no failures. These are guard, validation, recovery, and type-surface tests, not completed real-cloud lifecycles.
- An additional **81 existing Neon regressions** across 11 files passed, covering runtime scopes, typed objects, AI adapters, Website artifacts and provider composition.
- Full workspace typecheck passed. Distilled's strict Neon package typecheck and the combined **377 SDK tests / 753 assertions** passed; the companion revision is `5661366be2a70f3510d864f2e1d94f99e3b2f895`, with green CI.
- Organization and personal API-key creation secrets are sensitive in the upstream OpenAPI patch and regenerated SDK. Alchemy exposes a Redacted reveal-once key, retains it only for the observed numeric ID and scope, and refuses name-only recovery or silent rotation.
- Role controls preserve the original role/direct grant and never remove memberships. Organization `member` and `editor` are compared as equivalent legacy/current spellings. Self mutations and ambiguous interrupted role changes fail closed. Successful bounded listings, with organization-admin visibility where necessary, establish missing parents during cleanup; an ambiguous 404 alone never discards state.
- Spending thresholds are alert-only, not hard budget caps. The original threshold, including null, is captured before mutation. Role and spending controls require resolved initial properties, and must be restored/removed before their organization, member or project identity changes.
- Private-network resources manage Neon associations only, never AWS endpoints. Existing associations need scoped adoption and preserve their prior labels. Organization endpoint unregistration is irreversible for that endpoint in the same organization and has its own additional test opt-in.
- Source JSDoc, generated references and the governance guide were added. Browser checks traversed 82 navigation destinations at each desktop/mobile size, including all Neon sidebar destinations, each of the six new reference links, reference anchors and browser-back navigation; no overflow or page errors were observed.

No real governance mutation or entitlement probe was performed: no designated fixtures were supplied. Live prerequisites are:

| Cases | Explicit fixture configuration |
| --- | --- |
| Project-restricted organization keys | `NEON_GOVERNANCE_TEST_ORG_ID` |
| Project member grants | Organization plus `NEON_GOVERNANCE_TEST_MEMBER_ID` for an authorized active non-admin member |
| Organization role changes | Member fixtures plus `NEON_GOVERNANCE_TEST_ALLOW_ORG_ROLE_CHANGE=1` |
| Spending alerts | Organization plus `NEON_GOVERNANCE_TEST_SPENDING=1` and positive `NEON_GOVERNANCE_TEST_SPENDING_LIMIT_CENTS` |
| Existing private endpoint adoption and project associations | Organization plus `NEON_GOVERNANCE_TEST_NETWORK=1`, `NEON_GOVERNANCE_TEST_VPC_ENDPOINT_ID`, and `NEON_GOVERNANCE_TEST_VPC_ENDPOINT_REGION` |
| Irreversible organization-endpoint unregistration | Network configuration plus `NEON_GOVERNANCE_TEST_VPC_UNREGISTER=1` and a fresh disposable endpoint |

All fixtures need the corresponding Neon authorization/entitlement. Invitations remain out of scope because the public API has no corresponding revoke lifecycle. These additions do not resolve the pre-existing Function, AI, Website or historical cleanup acceptance blockers below.

## Comprehensive example consolidation

The seven backend/Function/tutorial example packages are now one `examples/neon` package with shared resources, while all 13 `neon-website-*` example directories remain unchanged. Existing tutorial stack identities are preserved; ignored local state and credentials remain in their original directories, with migration and legacy cleanup instructions in the new README. AI and additional Function forms are opt-in; paid inference remains separately disabled by default.

- **42 offline tests** passed, retaining upload-policy and Effect AI coverage and adding native negative-path/composition checks.
- **One live consolidated-backend test** passed: deployment of 13 resources, private/public buckets, typed objects, Auth, upload and cron trigger configuration, unauthenticated-request rejection, real upload-event processing and SQL persistence, exact download bytes, and normal destruction with an out-of-band project-not-found check. Cron delivery itself was not awaited.
- Full workspace typecheck, frozen-lockfile install, relocated frontend production build and documentation build passed. The retained framework examples were not redeployed.
- Desktop/mobile browser checks exercised the moved upload UI's unconfigured controls and the native AI UI's unauthorized/disabled-inference behavior. Documentation checks passed across 92 navigation checks per viewport, 10 guide flows, 59 internal-link/back flows and six code-copy checks.
- The AI guide now directs readers to buy credits in Neon Console and links to Neon's purchase instructions. The requested signed-in purchase walkthrough was cancelled by the user before authentication; no payment, upgrade or inference occurred.
- Signed-in browser upload/download, preview adoption/isolation, optional consolidated deployments, successful paid inference and historical account cleanup remain outside this verification result.

## Query binding names

`QueryDataApi` / `QueryDataApiHttp` replace `ConnectDataApi` / `ConnectDataApiHttp`. `QueryAIGateway` / `QueryAIGatewayHttp` replace the corresponding Connect names, aligning the AI binding's name and existing `.model(...)` interface with `Cloudflare.AI.QueryGateway`. Old aliases and source paths are removed. Caller-token forwarding, injected/managed credential selection and inference behavior are unchanged; permission provisioning remains out of scope.

- Full workspace typecheck, JSDoc validation and generated documentation build passed.
- **40 focused tests** passed, including three real deployments exercising Neon Functions, Cloudflare Workers and AWS Lambda with ordinary cleanup; the other cases cover public exports, AI transport, credential selection and type assertions.
- **17 AI example tests** passed, covering input/auth checks, model selection, streaming, errors and cancellation. These use a mock model, not paid inference.
- Browser checks passed with **92 navigation checks per desktop/mobile size**, 10 Setup-to-guide flows, 59 internal-link/back flows and six code-copy checks. Both renamed pages and their copied examples use the new names; navigation contains no obsolete Connect query pages.
- No additional paid inference, permission lifecycle or full-provider acceptance was claimed.

## HTTP-only implementation layers

Neon's 12 public runtime implementation layers now use only `*Http`, without `*Binding` aliases. Storage and AI Gateway reuse injected credentials for a known same-branch live Function, otherwise manage scoped credentials; explicit credentials override injection. The low-level `FunctionTrigger` remains available, while Effect handlers use `BucketEventSource` / `CronEventSource` with their HTTP layers.

- Full workspace typecheck, JSDoc validation, API-reference regeneration and website `docs:check` passed.
- **46 focused regressions** passed across credential selection/public exports, AI clients, typed objects, event decoding and Function bridge behavior.
- **12 deployment/integration tests** passed across live Neon Functions, real upload and cron delivery, trigger lifecycle, Cloudflare Workers, AWS Lambda and RPC-backed local Functions. These were separate scoped runs, not a complete provider acceptance round.
- The first external-host run passed three Worker/local tests but failed two Lambda tests because AWS SSO had expired. After successful `aws sso login`, both Lambda cases passed, including ordinary destruction of the interrupted stacks and their replacement test deployments. No ownership or state bypass was used.
- Browser verification traversed **90 documentation routes at each desktop/mobile size**, exercised 10 Setup-to-guide flows, 58 internal-link/back flows and two code-copy checks, and reported no errors. Removed Binding reference routes are absent from navigation; event-source and invocation contracts link to their HTTP implementation pages.
- Paid AI inference was not rerun. The existing entitlement, full-runtime, Website-matrix and historical cleanup blockers below remain open; these tests do not establish an account-wide zero-leak result.

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

The earlier account-level `ai gateway not enabled for account` rejection is resolved after the user corrected a declined credit purchase. Enabled-model paid inference and the complete Effect AI runtime case passed with `gpt-oss-20b`. Foundation-model access is separate: `gpt-5-mini` still returns `model requires a verified account`. Select from `/v1/models` entries with `enabled: true`; tool/structured-output support also varies by model. No purchase or account-plan change was made by the test runner.

### Website acceptance

All 13 constructors and examples exist. The full 13-framework live matrix has not passed. Native runtime checks target Linux ARM64/glibc per the official Neon config runtime; ELF header validation alone does not establish Node addon ABI or framework behavior. Next's request origin is now initialized from each Fetch request before invoking its full custom-server router, rather than rewriting redirect responses. Three real framework build tests passed, including concurrent origin/port/protocol variants and external redirects. The corrected Next artifact passed local production browser interactions; the actual Vocs example passed live browser interactions and cleanup. The separate live Next deployment failure remains.

### Cleanup

Parent/preview tutorial stacks were recovered through ordinary lifecycle operations. Two historical projects then remained without recoverable state: `spring-term-76599638` (scratch upload Function, trigger and storage) and `fragrant-fog-27766379` (interrupted Next feasibility deployment).

With explicit user authorization, `pnpm nuke --include 'Neon.*' --profile testing --yes` removed both projects and their dependent resources. The command reported **seven targets deleted in one pass**, with no failures or held resources. No other provider was selected; billing, organization membership and management API keys were retained.

The initial dry run exposed a shared SDK cursor bug: Neon's final empty project page repeats its cursor, so Function, trigger and domain enumeration never finished. Core cursor pagination now stops on previously requested cursors while preserving empty pages with advancing cursors. The fix has 19 targeted regressions; the combined core/Neon SDK run passed **355 tests / 679 assertions**, and the full workspace typecheck passed.

The post-delete `pnpm nuke --include 'Neon.*' --profile testing --dry-run` reported **Nothing to delete**. Independent API calls found **zero projects** both account-wide and in the visible organization, **zero organization private endpoints**, and typed `NotFound` responses for both historical project IDs. This clears the historical cleanup blocker; it is not a substitute for the still-pending two complete leak-free test rounds.

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
