# Neon.Function, runtime bridge and local provider

Initial status: **missing**. Gates G0–G7, G9–G10. One Function resource/provider supports native Fetch code and Effect-native code. Do not introduce Prisma/Bun listening-server semantics or require an `isExternal` user flag.

## Files and anchors

Implement under `packages/alchemy/src/Neon/` with Function contract/provider, narrow generated Fetch entry/bridge, local provider, environment binding helpers, WebSocket/waitUntil helpers and logs integration. Extend Neon Providers/index minimally. Tests under `packages/alchemy/test/Neon/` use suite-owned native and Effect fixtures; Function local tests use RPC sidecar. Read `Platform.ts`, `Runtime.ts`, `RuntimeContext.ts`, WorkerBridge, Lambda entrypoints, `Local/ProviderLayer.ts` and `Local/LocalProvider.ts` before implementing.

## Public inputs and attributes

| Input | Type/default | Rule |
| --- | --- | --- |
| branch or project | exclusive common scope | Scope change replaces. Default branch is observed, not assumed `main`. |
| slug | optional string; deterministic collision-resistant suffix | Immutable identity; `^[a-z0-9]{1,20}$`. Do not use generic hyphenated names. Explicit slug change replaces. |
| name | optional display string | Mutable; SDK PATCH accepts null to clear and fall back to slug; rejects whitespace-only name. |
| main | module entry path/URL | Native object `{ fetch }`, bare default handler, Hono default export, or generated Effect bridge. Exclusive with prebuilt source. |
| prebuilt artifact | supported ZIP/directory alternative | Exclusive with main; validate paths/bytes/archive limits, package ESM index.mjs and required files. Public property spelling must be settled by Function owner consistently with Websites. |
| env | string/redacted map | Write-only values; names observable. Empty wire value deletes. Omitted managed keys must send empty deletion values. Reject accidental collisions with binding/injected variables. |
| bundle/dev controls | existing supported vocabulary | Node 24 ESM, CJS interop, native local runtime. No memory-size/port/container controls invented. |

Stable identity is projectId + branchId + slug, with opaque functionId from API. Attributes include slug/name/url, currentDeploymentId/status and activeDeploymentId/status, desired code/env hashes, managed env-key ownership and safe runtime metadata. Never conflate current (possibly building/failed) with active (servable). Deployment IDs are numbers, monotonically increasing per Function. URL may be empty in API; don't report readiness without a valid invocation URL.

Public Effect surface supports `Function(id, props, implementation)`, `class X extends Function<X>()(...)`, and `.make(props, implementation)` Layer form from Platform. Native authors use ordinary SDKs and process.env without Effect. Async application fixtures are allowed; provider/helpers remain Effect-native.

## Actual SDK lifecycle

| Phase | SDK operation / wire |
| --- | --- |
| Observe | `getProjectBranchFunction({ project_id, branch_id, slug })`: GET branch `/functions/{slug}`; recovery/list via `listProjectBranchFunctions` with advancing `pagination.next`. |
| Ensure / deploy code or env | `createProjectBranchFunctionDeployment({ project_id, branch_id, slug, zip, runtime: "nodejs24", environment })`: POST branch `/functions/{slug}/deployments`, multipart. First deploy requires ZIP; config-only deploy can omit ZIP to reuse latest bundle. No standalone createFunction API. |
| Sync display name | `updateProjectBranchFunction({ project_id, branch_id, slug, name })`: PATCH `/functions/{slug}`. |
| Observe deployment readiness | Repeated `getProjectBranchFunction`; match the requested deployment ID in completed active state, inspect current failed status and sanitized reason, validate invocation_url. Never accept an old active deployment as new success. |
| Delete | `deleteProjectBranchFunction({ project_id, branch_id, slug })`; typed absence tolerance and fresh get verification. Remove owned triggers/domains before Function; no parent branch mutation. |
| Logs | `queryProjectBranchLogs({ project_id, branch_id, source, service_name, ... })`; use actual Function filtering established by fixture, time window, limit and cursor. Optional field discovery via `listProjectBranchLogFields` / `listProjectBranchLogFieldValues`. Do not expose other applications' log bodies. |

Observe → ensure → sync applies to missing/owned/adopted cases. If safe pre-create is needed to resolve runtime binding cycles, produce an owned no-op stub through the same deployment API and don't mistake the stub as desired code. Treat inherited same slug as foreign pending explicit child adoption; mutation/deletion acts only on child scope. Name equality alone does not prove a deployment is ours.

## Write-only env and deployment recovery

SDK currently types ZIP as optional string; this is a **blocking binary contract gap**, not permission to cast bytes to string. SDK owner fixes multipart binary representation/serialization and a single JSON-string environment part. Wire tests assert filename, boundary and original ZIP bytes. Bodyless deletes and failed/current/active/nullable fields must reflect observed responses.

Hash desired artifact/env to avoid unchanged deployment churn. On an actual reconcile requiring mutation, reassert desired env values and delete removed keys. An unchanged desired hash does not prove live write-only value equality. Explicit adoption must define which pre-existing env names it owns; do not delete unowned names. Docs confirm user-defined values can override Neon-injected defaults, so Alchemy must diagnose accidental `DATABASE_URL`, `AWS_*`, `NEON_AUTH_*`, `NEON_AI_GATEWAY_*` collisions rather than pretend these names are platform-reserved. Empty desired value is deletion, not a storable empty string; document and validate this limitation.

There is no documented upload idempotency key or arbitrary code download. If a successful deployment response is lost, convergence may require another deployment; do not claim exact lost deployment ownership/recovery. Track observed IDs only when proven, keep immutable Function ownership separate, and never rotate credentials as recovery.

## Runtime/security contract

Neon runs Node.js 24, fixed 2048 MiB, concurrent requests per isolate, 15-minute first-byte/idle-stream/waitUntil limits, SIGINT with five-second shutdown grace. These are platform limits, not justification for long tests. URLs are public; examples enforce caller authentication inside handlers. `functions:invoke` scope is not a policy gate.

Cache service/runtime construction once per process, not request context or disposable resources. Give every request its own Scope/context, trace/cancellation/finalizers; no cross-request service leakage. Preserve cookies, HEAD/bodyless status behavior, response streaming/backpressure and error reporting. Preserve the exact native WebSocket upgrade Response object including runtime metadata; do not clone it through ordinary conversion. Add an Effect-facing upgrade helper and native passthrough using upstream `@neon/functions`. waitUntil adapter must track observable failures and retain the documented nondurable 15-minute semantics; don't promise durable jobs. Instance teardown on SIGINT is best effort within five seconds; disposable Effect resources remain request-scoped.

Same-branch Function bindings use injected DATABASE_URL[_UNPOOLED], AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY/AWS_ENDPOINT_URL_S3/AWS_REGION, NEON_AUTH_BASE_URL/JWKS_URL and NEON_AI_GATEWAY_TOKEN/BASE_URL when enabled. Account NEON_API_KEY must never be bound or bundled. A read-only binding does not revoke the process's broader injected credentials.

## Local provider

Register `ProviderLayer.dual` live/local thunks; use `LocalProvider.make` with plain config hashing and process readiness/invalidation. Resolve local-only dependencies inside the local thunk. Serve the same native/generated Fetch entry with Node 24, code/env HMR and cleanup. Bind explicitly declared remote resources using managed scoped credentials and namespaced env; do not mutate global AWS credentials. `.remote()` deploys a real Function during dev. Mode transitions and delete use engine stamped dispatch. Test local WebSocket compatibility separately; generic Node Fetch serving does not prove it.

## Exact acceptance

- Real deployment/invocation of native object, bare function and Hono, code/env updates, removed env key verified by handler, display-name clear, no-op unchanged deployment ID, immutable slug/scope replacement.
- Lost-state/repeated reconcile/adoption/foreign inherited slug handling; failed current deployment fails rather than returning old active URL. Bounded waiter handles no URL, unknown status and exhaustion explicitly.
- Effect constructor/class/Layer fixtures verify Config, SQL and storage, concurrent request isolation, stream backpressure/cancel, cookies, HEAD/204/304, typed/non-success failures and request-finalizer timing.
- Live WebSocket handshake and messages preserve native response identity; local equivalent explicitly tested; waitUntil completion/failure visible after response; SIGINT cleanup bounded.
- Generated artifact contains no Bun/workerd runtime imports, source-only credential files or account key; Node 24 ESM/CJS dependency fixtures actually execute.
- Logs contain only the owned Function fixture marker using SDK query/filter; redacted diagnostics do not leak env values or broader branch logs.
- RPC local code/env reload, process invalidation, cleanup, remote opt-out and local/live stamped destroy pass.
- Native and Effect examples + guides exist; G7 static/SSR/Next feasibility passes before Website family work is called supported.

Sources: https://neon.com/docs/compute/functions/environment-variables and https://neon.com/docs/compute/functions/reference/runtime-limits. No Function runtime/entitlement probe ran in this preflight.
