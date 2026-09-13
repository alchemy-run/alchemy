# Cloudflare runtime and Vectorize audit

Audit date: 2026-09-13. This is an evidence ledger, not a claim that every Cloudflare service has a faithful local implementation. Every binding module exported by `packages/cloudflare-runtime/src/core/bindings/index.ts` was inventoried. Existing local implementations were assessed for explicit limitations and test coverage; only the changes and tests identified below were executed by this audit worker.

## Vectorize resource coverage

| Resource/surface | API and lifecycle audit | Changes / verification | Remaining limits |
|---|---|---|---|
| `Vectorize.Index` | All V2 create configuration fields are exposed: name, description, dimensions/metric or preset. API has get/list/create/delete, no mutable index update. Existing ensure catches missing index and create conflict, uses cached physical name and recorded account for delete. | Diff now also detects observed immutable dimension/metric mismatch. Live explicit creation/deletion, preset, dimension replacement, list tests passed. Added dual RPC local provider and dev identity, Worker descriptor configuration. | Unknown future presets require explicit local implementation (clear error); exact cloud preset validation, deleted-index name reuse latency and all cross-account permutations are not live verified. |
| `Vectorize.MetadataIndex` | Exposes parent index, property and supported scalar type; create/list/delete covered. Existing reconciler incorrectly returned desired type while observing a different type. | Observed type drives diff; reconcile deletes/recreates a drifted type with bounded typed conflict retry. Concurrent-create conflict checks observed type. Added dual RPC local provider, local metadata registry, Worker/Vite restart wiring. Local create/filter/remove lifecycle passed. Same-property type replacements now delete the old generation first. | Cloud indexing is asynchronous. Five legacy asynchronous materialization cases are opt-in with CLOUDFLARE_TEST_VECTORIZE_ASYNC_METADATA=1 and bounded to ten 5s polls/120s test timeout. Ungated deployed mutation acceptance, repeated deploy, SDK parent verification and idempotent cleanup passed. Full materialization/adoption drift not live verified. |
| `Vectorize.SearchIndex` native binding | describe/query/queryById/insert/upsert/getByIds/deleteByIds map to current Worker API. | Added missing `InferEnv` mapping to native Vectorize. All methods covered by local binding test. | Vector listing is REST-only and not currently exposed in this binding contract. |
| `SearchIndexLocal` HTTP client | This existing name means local *process* calling the live HTTP API, not offline emulation. | Implemented queryById as get+query; namespace now forwarded by patched distilled schema. Live namespaced queryById confirmed only target namespace is returned. | `raw` deliberately unsupported. Two-call queryById is not an atomic read/query snapshot. Token-scoped SearchIndexHttp layer is still absent. |

## New local Vectorize implementation

`Vectorize.local({ binding, indexName, dimensions, metric, metadataIndexes })` uses the real workerd `cloudflare-internal:vectorize-api` binding over a local Durable Object. Data persists in the runtime storage directory under `vectorize`; SQLite-backed transactions serialize mutations. Request bodies are parsed before retryable storage transactions. Configuration mismatch across bindings sharing an index is rejected.

Verified: insert keeps existing IDs, upsert fully replaces metadata and values, missing delete is idempotent, batch validation is atomic, concurrent mutations do not lose vectors, index identities isolate state, bindings sharing an index see the same data, and restarting workerd retains vectors. Search implements cosine/euclidean/dot-product, deterministic score ordering, namespace filters before topK, queryById, optional returned values, all/indexed/no metadata, eight comparison operators, implicit AND, dotted properties, float32 vector storage, and UTF-8 metadata-index truncation. Metadata is snapshotted on insertion, so creating an index does not retroactively index old vectors.

Intentional limits: exact linear search rather than Cloudflare approximate search; immediate visibility rather than mutation processing latency; no distributed regions/quotas/rate enforcement; no management REST listener or REST vector listing; runtime metadata indexes are configuration, not public Worker methods. Alchemy local destroy isolates later generations with a new `dev:` identity and leaves orphan disk data for `.alchemy` cleanup, consistent with local D1. Local metadata generation identifiers invalidate old indexed snapshots on delete/recreate, preserving the documented no-retroactive-indexing behavior; full comparison with cloud type replacement remains gated. Cross-process simultaneous access uses existing workerd disk semantics and has not been stress-tested across independent runtimes.

## Runtime binding inventory and local feasibility

| Family / exported modules | Existing implementation / limits | Audit disposition |
|---|---|---|
| KV (`KvNamespace`) | Durable Object + blob-backed persistent KV; get/put/list/delete, metadata, TTL. Dedicated runtime tests exist. Cloud eventual consistency and geographical cache semantics cannot be reproduced by one machine. | Existing, static reviewed. |
| R2 (`R2Bucket`) | Persistent object metadata/blobs, multipart, conditional reads/writes, checksums/ranges/list. Dedicated extensive tests exist. | Added lock rule propagation and enforcement for overwrite, delete (whole-batch precheck), multipart completion; age/date/indefinite/prefix conditions. Added persisted lifecycle policies, alarm-driven age/date object expiry, InfrequentAccess transitions, multipart abort and per-object/default storage class. Locks take precedence over expiry. Deployed lifecycle fixture passed. CORS controls browser HTTP/S3 requests, so it correctly does not gate native Worker binding calls; a local public-domain/S3 HTTP gateway is outside this native interface. |
| D1 | SQLite Durable Object wrapped by native d1-api; batch, sessions/bookmarks and migration/import local resource support. | Existing, static reviewed. Read replication placement and production query capacity are not local equivalence. |
| Queues | Durable Object broker, consumers, ack/retry/batching and local registry. | Coordinator owns settings and broker fixes. No competing changes here. |
| Durable Objects / `DurableObjectNamespace` | Native workerd storage/RPC, cross-worker registry proxy; container support via Docker. | Existing; distribution/placement and production limits not emulated. |
| `Service`, `Loopback`, `WorkerLoader` | Native or registry-mediated service/RPC, local loopback, workerd loader. | Existing; dedicated service/loopback tests. |
| `Assets`, `Cache` | Local asset/router workers and HTTP cache storage. Cache can be explicitly disabled to no-op. | Existing; asset/CDN regional behavior is not emulated. |
| Workflows | Local workflow engine, durable instance/step state, retries/events. | Existing dedicated tests; not audited against every workflow limit in this pass. |
| Hyperdrive | Local origin connectivity; native wrapper. | Existing; cloud connection pooling/routing/cache fidelity not established. |
| Browser | Real local headless Chromium with CDP proxy. | Existing; supported host platforms and cloud session limits differ. |
| Images | Persistent hosted object store; Sharp transformations. | Added GIF/raw RGB/RGBA, quality/background, ordered resize/rotate, fit modes, flip/blur/sharpen/color/border/trim and overlays with compositing/clipping. Deployed pixel assertions and native tests passed. Added font-URL text rendering using the requested font, escaped text, color/size and ordered text overlays; animated GIF/WebP frames retain frame delays/loop and transforms, with anim:false selecting the first frame. Deployed text/animation fixture passed; mixed text/image overlays are verified. The Effect client now exposes the native text() method, with an actual deployed Effect-worker fixture. AI segmentation/face gravity, coordinate gravity, custom trim-border settings, directional overlay repeat and animated-overlay timeline composition remain gaps. |
| Stream | Local video records/blobs and preview route, no transcoding/signing. | Added persistent direct-upload tokens, expiry, one-use multipart POST, invalid file handling, atomic concurrent token consumption, metadata and deletion invalidation. Deployed fixture and native suite passed. Duration constraints recorded without decoding media; watermark metadata is returned without rendering, HLS/DASH/signing/TUS and scheduled deletion remain local limits. |
| SendEmail | MIME validation, permitted destination/sender checks, local capture (no Internet delivery). | Existing emulator; actual mail delivery intentionally external. |
| RateLimit | Fixed-window local limits. | Shared host-loopback counters now use namespace/key/period across bindings and Workers in one runtime. Deployed two-Worker alias/namespace-isolation fixture passed. Independent runtime processes and geographically approximate production semantics differ; counters are not persisted across runtime shutdown. |
| AnalyticsEngine | Former write-discard stub. | Added per-dataset SQLite point persistence, binary blobs/indexes, limits validation, nonblocking request-lifetime writes, local getDataPoints pagination and read-only query(sql) SQLite subset with production column names. Deployed binary/aggregate/validation/restart fixture passed. Sampling, ClickHouse-specific syntax, full SQL HTTP API, per-invocation 250-point quota and writeDataPoints batch API are not emulated. Retention is approximated as 92 days. |
| SecretsStore | Local secret records resolved via native-shaped getter; resource local provider. | Existing; IAM/token scope enforcement not modeled locally. |
| `Text`, `Json`, `Data`, `WasmModule`, `SecretKey`, `VersionMetadata`, `UnsafeEval` | Native workerd values/crypto/metadata/eval configuration. | Existing; most have dedicated runtime tests. |
| DispatchNamespace | Previously remote-only; added dual local resource provider, Worker namespace propagation and namespace-qualified local registry routing. | Deployed two-namespace fixture verifies identical script names remain isolated, request forwarding, dynamic updates/removal and missing-target errors. Fetch supported; outbound workers/parameters and per-invocation CPU/subrequest limits explicitly reject in local mode. No dispatch RPC or undocumented connect/socket emulation is claimed. Local namespace scriptCount remains a virtual zero attribute rather than a live registry count. |
| Vectorize | Previously remote-only. | Implemented and verified as above. |
| AI / AiSearch | Remote binding bridge only. | Model inference cannot be faithfully substituted without model/runtime dependencies; retrieval-only fixtures feasible but would be a mock. |
| Artifacts | Remote bridge only. | Storage/app-serving subsets plausibly feasible; no local implementation verified. |
| Flagship | Persistent offline App/Flag dual providers and native/Effect binding evaluation. | Actual local deployed fixture verifies all typed/value/details methods,11 operators, nested AND/OR, date comparisons, disabled/default/targeting/split reasons, missing/type/context fallbacks, immediate updates, restart persistence and deletion. Rollouts use documented cumulative thresholds with local FNV-1a bucketing; exact Cloudflare membership is not claimed. |
| Pipelines | Remote bridge plus new coordinator-owned local work. | Coordinator owns runtime ingestion/persistence/validation audit; see core ledger. |
| Media | Remote bridge only. | Production media operations external; limited local transform adapter feasible. |
| MTLS Certificate | Remote bridge only. | Client-certificate TLS could use local credentials; certificate deployment/trust is external. |
| VPC Network / VPC Service | Remote bridge only. | Real Cloudflare private routing cannot be reproduced offline; local target adapter could approximate application requests. |

Cloudflare control-plane resources without Worker runtime bindings (DNS, zones, certificates, Access policies, WAF/rulesets, load balancing, networking, registrar, account permissions, logging configuration, etc.) do not automatically become emulated by cloudflare-runtime. Selected request-routing/security behavior could be modeled, but declaring fake resources without enforcing their effects would be misleading. Their reconciler/API audits belong in the coordinator/service ledgers.

## Sources inspected

- https://developers.cloudflare.com/vectorize/reference/client-api/
- https://developers.cloudflare.com/vectorize/reference/metadata-filtering/
- https://developers.cloudflare.com/vectorize/best-practices/insert-vectors/
- https://developers.cloudflare.com/api/resources/vectorize/subresources/indexes/methods/create/
- https://developers.cloudflare.com/api/resources/vectorize/subresources/indexes/methods/query/
- https://raw.githubusercontent.com/cloudflare/workerd/main/src/cloudflare/internal/vectorize-api.ts (native transport contract)
- https://developers.cloudflare.com/r2/buckets/bucket-locks/
- https://developers.cloudflare.com/r2/buckets/object-lifecycles/
- https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/dynamic-dispatch/
- https://developers.cloudflare.com/analytics/analytics-engine/limits/
- https://developers.cloudflare.com/analytics/analytics-engine/get-started/
- https://developers.cloudflare.com/analytics/analytics-engine/sampling/
- https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- https://developers.cloudflare.com/images/optimization/binding/
- https://developers.cloudflare.com/images/optimization/features/
- https://developers.cloudflare.com/images/optimization/draw-overlays/
- https://raw.githubusercontent.com/cloudflare/workerd/main/src/cloudflare/internal/images-api.ts (ordered multipart transport)
- https://raw.githubusercontent.com/cloudflare/workerd/main/src/cloudflare/workers.ts (internal request-lifetime waitUntil)
- https://developers.cloudflare.com/stream/uploading-videos/direct-creator-uploads/
- https://developers.cloudflare.com/api/resources/stream/subresources/direct_upload/methods/create/
- Local generated distilled vectorize SDK and all existing vectorize patches; package binding modules and tests.

## Executed checks (updated at completion)

- Vectorize edge cases through actual workerd: 7 passed (replaced all 19 standalone pure algorithm cases); `.audit/cloudflare/vectorize-native-fixtures.log`.
- Native workerd Vectorize integration: 1 passed.
- Live Vectorize Index + SearchIndexLocal: 5 passed (four resource tests + original HTTP lifecycle).
- Live HTTP namespaced queryById regression: 1 passed after patch.
- Local resource Index/MetadataIndex: 2 passed (one Index retry, then expanded readiness bound).
- Local R2 BucketLocks: passed, clean rerun4.6s; native Vectorize/R2 lock suites22passed.
- Local AnalyticsEngine/RateLimit deployed fixtures:2passed (coordinator log `.audit/cloudflare/analytics-ratelimit-local.log`).
- Native Images/Stream/RateLimit suites:102passed (`timeout 240 pnpm --filter @alchemy.run/cloudflare-runtime test --project core Images.test.ts Stream.test.ts RateLimit.test.ts`).
- Local Images/Stream deployed fixtures:2passed (`.audit/cloudflare/media-local.log`).
- Live Vectorize.MetadataIndex:1passed/5explicit async skips (`.audit/cloudflare/vectorize-metadata-live.log`).
- Expanded deployed metadata generation delete/type-replace/recreate: 1 passed (`.audit/cloudflare/vectorize-metadata-local.log`).
- Native R2/Vectorize/Stream final batch: 131 passed (`.audit/cloudflare/runtime-native-final-green.log`). R2 locks/Images/Service also passed 28 tests (`.audit/cloudflare/runtime-final-locks-images-service.log`).
- Deployed R2 lifecycle/locks and entire Stream directory: 16 passed, one existing todo (`.audit/cloudflare/deployed-r2-stream.log`).
- Images native text, Effect-client text, mixed image/text overlays and animated GIF deployed fixture: 1 passed with --retry 0, 20s (`.audit/cloudflare/images-effect-text-no-retry.log`). Earlier attempts retried transiently; last verification required no automatic retries.
- Dispatch namespace deployed fixture: passed; initial removal assertion raced registry propagation. Updated readiness check to await the missing-target error instead of accepting a transient connection error; clean pass recorded in `.audit/cloudflare/dispatch-images-final.log`. Resource-reference plus string namespace props also passed (`.audit/cloudflare/dispatch-resource-reference-final.log`).

No mocked reconciler tests are included. New local tests deploy real fixture Workers through the existing test.provider lifecycle; runtime integration suites start real workerd. All new vector and retention edge-case coverage executes actual workerd deployments; no standalone pure algorithm suites remain.

SDK patch: `patches/vectorize/queryIndexNamespace.manual.json` adds the optional namespace member to the Smithy request shape; regenerated only vectorize. Live namespace query verified. No source SDK workaround or catch-all error handling was introduced.

## Flagship offline verification (2026-09-13)

`flagship-local-final.log`: actual Alchemy local deployment,2/2 passed in6.3s using native workerd and an Effect Worker. Per-app/per-flag atomic JSON files persist definitions and avoid lost concurrent writes. Reads occur per evaluation so separate Workers and live flag updates share current definitions. App deletion removes its flags. `ReadFlagsLocal` also evaluates local App IDs offline inside actual Actions, while preserving HTTP evaluation for live App IDs. Rules support all11 documented operators and nested conditions; numeric/ISO8601 comparisons use numeric instants; typed methods return documented error details/fallbacks.

Rollout provenance: official https://developers.cloudflare.com/flagship/targeting/percentage-rollouts/ documents consistent hashing, account/flag isolation, targetingKey default, random assignment without key, and cumulative percentage thresholds. It does not publish the hash algorithm. Local implementation uses FNV-1a over JSON(accountId,flagKey,contextAttribute), preserves one bucket across cumulative rules, and explicitly does **not** claim identical Cloudflare user membership. Global replication delays/edge caches are outside local emulation. Other references: https://developers.cloudflare.com/flagship/targeting/operators/ and https://developers.cloudflare.com/flagship/reference/evaluation-reasons/.
