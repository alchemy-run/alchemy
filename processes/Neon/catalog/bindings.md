# Neon runtime binding catalog

All ten contracts below are initially **missing**. This file specifies each contract and all required implementations independently. Event sources are in `triggers-domains.md`. Gate set G0, G3–G6, G9–G10. Existing Prisma.Connect/R2 bindings are patterns, not Neon completion evidence.

## Shared implementation contract

Use current callable `Binding.Service`: tag, type and callable under one public identifier. Inner runtime effects require RuntimeContext; outer init Effect does not. Resolve host/config once and keep host services encapsulated, with disposable I/O acquired lazily per request Scope. Register dependencies/env through `host.bind` guarded by `!globalThis.__ALCHEMY_RUNTIME__`; build implementation layers once and provide them once on Function/Worker/Lambda. Keep shared storage/credential/host helper files internal, with service-unique helper names. No native Cloudflare object binding or AWS IAM is fabricated for Neon.

Same-branch Neon Function uses platform-injected env and adds only resource dependency/nonsecret name wiring. External Worker, Lambda, local Function or explicit cross-branch access uses managed target-branch `Credential` where the service requires a bearer/S3 token. Secret bindings are namespaced by host/resource/branch, deduplicated for matching branch/scope requirements and cleaned up through resource ownership. Do not overwrite ambient AWS credentials or another branch's variables. Explicit credential override must validate supported scopes/lineage. Borrowed credentials are never revoked by the client; managed credentials are.

No account `NEON_API_KEY` in any runtime, browser, artifact or log. `storage:write` includes read; branch ancestor credentials can reach descendants. The typed client shape is not a bucket/key sandbox and same-branch automatic credentials are not downscoped by a read-only binding. The SDK needs redaction for S3 secrets; never log its raw request/error structures. Binding identities are references/dependencies, not independently named cloud objects; target changes retarget binding data and replace only owned credentials/host deployment where required.

## 1. Connect

- Call: `Neon.Connect(branchOrProject)`; outputs redacted connectionString/pooled and direct connection effects, keeping existing Project/Branch connection outputs compatible. Runtime effects are accepted by `SQL.Postgres({ url })` and Drizzle.
- Implementations: `ConnectBinding`, with same-branch injection and explicit namespaced connection secret wiring for other supported hosts. Do not invent a branch service-token scope for database login.
- Deploy mapping: source Project/Branch outputs or `getConnectionURI({ project_id, branch_id, database_name, role_name, pooled })` through their refresh; no new database/role created by binding.
- Runtime env: DATABASE_URL and DATABASE_URL_UNPOOLED on same-branch Function; namespaced redacted values on Worker/Lambda/local host.
- Acceptance: actual SQL query on Neon Function, Cloudflare Worker and Lambda using standard SQL/Drizzle integration; direct versus pooled semantics; two branches bound without collision; child writes leave parent unchanged; no pool acquisition during deploy/init; finalizer closes request-scoped pool; connection secrets absent in logs/client assets.

## 2. ReadBucket

- Call: `Neon.ReadBucket(bucket)`; client get/head/list and presigned downloads.
- Implementations: `ReadBucketBinding` for same-branch injected S3 configuration; `ReadBucketHttp` for managed storage:read credentials.
- SDK transport: `getObject`, `headObject`, `listObjectsV2` via existing S3 client/Effect transport and SigV4 presigning; discover endpoint/region with `getProjectBranchStorage`. Always path-style. Bound bucket limits API arguments, not provider permissions.
- Env: injected AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_ENDPOINT_URL_S3, AWS_REGION for native path; namespace equivalents for external path. token_id is access key; s3_secret_access_key is secret key.
- Acceptance: byte/range/metadata reads, typed missing object, prefix/delimiter pagination and presigned GET expiry; external read credential's attempted write denied; other same-branch buckets accessible at credential level documented; no needless customer credential on injected path; child/wrong lineage negative controls; revoke managed credential after host cleanup.

## 3. WriteBucket

- Call: `Neon.WriteBucket(bucket)`; put/delete/batch delete, multipart and presigned uploads.
- Implementations: `WriteBucketBinding` / `WriteBucketHttp`; external grant storage:write. Explicitly not write-only security.
- Transport: S3 `putObject`, `deleteObject`, `deleteObjects`, `createMultipartUpload`, `uploadPart`, `uploadPartCopy` where exposed, `listParts`, `completeMultipartUpload`, `abortMultipartUpload`, `listMultipartUploads`, SigV4 PUT/form signing where supported. Scope/endpoint resolution shared with ReadBucket.
- Acceptance: native/external upload/download confirmation; read succeeds with write credential (documented negative control for false write-only claim); 1000-key batch bound, real multipart completion/abort, browser CORS presigned PUT, expiration/denial and no cross-branch overwrite. Only own fixture keys deleted.

## 4. ReadWriteBucket

- Call: `Neon.ReadWriteBucket(bucket)`; interface extends ReadBucketClient and WriteBucketClient.
- Implementations: `ReadWriteBucketBinding` / `ReadWriteBucketHttp`; compose builders and one client/managed storage:write credential, not two copies.
- Mapping: union of preceding S3 operations; no extra permission scope.
- Acceptance: real get/put/list/delete roundtrip, inherited read/write limits, one client/credential for a combined bind, shared credentials across matching binds, no unsafe dedupe across branches. Destruction revokes only owned credential after all consumers stop using it.

## 5. ReadObject<T>

- Call: `Neon.ReadObject(object)`; typed JSON get returns `Effect<T | undefined, typed decode/storage error, RuntimeContext>`. Object fixes bucket/key. Raw byte/file resources keep raw APIs.
- Implementations: `ReadObjectBinding` / `ReadObjectHttp`, reuse ReadBucket transport and scope. No per-object credential claim.
- Mapping: S3 getObject/headObject through bound bucket. Parse malformed JSON as typed decode failure; optional Effect Schema validates external writes; TypeScript generic alone is not validation.
- Acceptance: inferred/explicit T propagates without cast/repeated key; malformed JSON and schema-invalid external write fail; missing returns undefined; raw bytes are exact; key/bucket replacement retargets correctly; permission documentation remains branch scoped.

## 6. WriteObject<T>

- Call: `Neon.WriteObject(object)`; typed JSON put(value: T), without manual stringify/key; raw object writer only accepts supported raw payload.
- Implementations: `WriteObjectBinding` / `WriteObjectHttp`, reuse WriteBucket storage:write credential/transport.
- Mapping: deterministic supported JSON serialization + application/json into S3 putObject; metadata matches declared object contract. No per-key IAM.
- Acceptance: wrong value fails compile, supported JSON roundtrip/schema validation, raw byte fidelity, no credential per Object when bucket/host/scope match. Document that an IaC Object's value is desired state and may overwrite runtime drift on reconcile; use bucket runtime writes for ordinary app data.

## 7. InvokeFunction

- Call: `Neon.InvokeFunction(fn)` returns bound HTTP callable preserving request/response streaming.
- Implementation: `InvokeFunctionBinding` (URL/env binding, not platform auth policy). SDK discovery belongs to Function `getProjectBranchFunction`; runtime uses Effect HttpClient/native fetch bridge against its public invocation URL.
- Authorization is explicit caller input/header; never automatically put deployment NEON_API_KEY in Authorization or claim functions:invoke secures the endpoint. Preserve caller cancellation, method/body/query and intended path resolution; disallow accidental host changes when joining relative paths.
- Acceptance: cross-Function and external-host invoke, cookies/status/streaming/cancellation, authorized success and unauthorized handler rejection. Function replacement URL update propagates, and public accessibility without handler auth is honestly documented.

## 8. ConnectAuth

- Call: `Neon.ConnectAuth(auth)` returns baseUrl/jwksUrl runtime effects/config usable with standard managed Better Auth clients.
- Implementation: `ConnectAuthBinding`; same-branch injected NEON_AUTH_BASE_URL/NEON_AUTH_JWKS_URL or namespaced public URL binding for external hosts. Does not create admin OAuth/user credentials.
- SDK mapping: Auth `getNeonAuth`; runtime auth endpoints/JWKS via established auth/JWT libraries.
- Acceptance: signup/signin/signout + protected API; JWT issuer/signature/expiry validation, invalid signature/wrong issuer denial, child Auth endpoint isolation and trusted-origin resources. No decode-only JWT security or server key exposed to browser.

## 9. ConnectDataApi

- Call: `Neon.ConnectDataApi(dataApi)` returns bound base URL/HTTP client requiring caller authorization for protected requests.
- Implementation: `ConnectDataApiBinding`; same-branch NEON_DATA_API_URL when appropriate, otherwise namespaced URL from resource. No implicit branch/API credential grants.
- SDK mapping: `getProjectBranchDataAPI` supplies URL/config; runtime PostgREST HTTP requests forward user's token exactly under intended authorization rules.
- Acceptance: authorized SELECT/write and RLS, unauthorized/expired/wrong token response, independent tenants/branches do not bleed auth; no captured global request token in a cached isolate client and no silent admin-key replacement. URL updates/removal/deletion propagate.

## 10. ConnectAIGateway

- Call: `Neon.ConnectAIGateway(gateway)` returns redacted token and endpoint effects compatible with @neon/ai-sdk-provider/model SDK configuration.
- Implementations: `ConnectAIGatewayBinding` for injected same-branch NEON_AI_GATEWAY_TOKEN/BASE_URL; `ConnectAIGatewayHttp` for external managed ai_gateway:invoke credential and namespaced configuration.
- SDK mapping: `getProjectBranchAiGateway` discovery + Credential lifecycle for non-injected path. No gateway CRUD or infrastructure chat method.
- Acceptance: native SDK streaming + Effect-wrapped call, configurable model, correct /v1 versus /openai/v1 routing, cancellation/failure propagation, target-branch token boundaries, Worker/Lambda configuration/invocation where permitted and credential revocation. Gate inference only on exact typed entitlement/credits errors; never purchase credits or mark a skip as a pass.

## Registration and completion checks

Export every contract and per-level implementation from Neon index. Keep shared BucketBinding/BucketHttp/credential-host helper files internal. Resource providers register Credential and the resource contracts only; runtime implementation layers are composed on hosts rather than pretending every binding is a provider.

Each contract gets its own named test describe with deployment-backed behavior; share one fixture deploy per suite using beforeAll/afterAll and real external HTTP calls. Compile tests cover RuntimeContext coloration and generic propagation. Http and injected variants are individually checked, not aliases counted as two passed implementations. Full cleanup verifies managed-token revocation and no own objects/Functions left. No bindings were executed in this assessment.
