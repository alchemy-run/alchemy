# Core Cloudflare resource audit

Audit date: 2026-09-13. Scope is the 24 existing resource contracts below. Management API fields were compared with the pinned distilled SDK and nested Worker upload metadata; live lifecycle evidence is separate from static review. No claim is made that every race or feature combination was exercised.

API references: [Cloudflare API](https://developers.cloudflare.com/api/), [Worker upload metadata](https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/), [Queues settings](https://developers.cloudflare.com/queues/configuration/configure-queues/), [R2 bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/).

Source roots: `packages/alchemy/src/Cloudflare` and `packages/alchemy/test/Cloudflare`. Test paths below are relative to the latter unless a separate ledger is named. All new provider regression coverage uses actual deployments, deployed fixtures and real out-of-band API mutations.

## Containers.ContainerApplication

API/reconciler review: Docker image/build, instances/scaling, placement/affinities/constraints, rollout configuration and jobs creation mode. Observe live version and configuration before trusting deployment fingerprints; jobs mode replaces before create.

Fixture/evidence: `containers.md`. 11 deployed cases passed; jobs entitlement probe passes, full jobs lifecycle gated.

Local feasibility: Real Docker/workerd HTTP execution; production scheduling, geographical placement and quotas remain Cloudflare services.

## D1.Database

API/reconciler review: All create and replication settings, SQL import and migration sequencing. Preserve cached name, reread replication, reset import/migration fingerprints after physical recreation, never clone into a raced existing database.

Fixture/evidence: `D1/Database.test.ts`. 14 live cases plus actual out-of-band delete/redeploy import recovery.

Local feasibility: Native SQLite/D1 API, imports and migrations. Remote replication placement and cloud backup/time-travel require service APIs.

## Hyperdrive.Connection

API/reconciler review: Public, Access-protected and VPC origin union; caching, mTLS, origin connection limits. Typed get/name recovery and concurrent-create handling; cached generated name.

Fixture/evidence: `Hyperdrive`. 8 live/local SQL cases passed. New VPC shape statically compared with SDK; actual VPC database connectivity requires an external tunnel/database.

Local feasibility: Direct SQL connection; Access/VPC origins require explicit reachable development origin. Cloud pooling/caching/placement not reproduced.

## KV.Namespace

API/reconciler review: Title create/update/list/delete, cached-name preservation and typed collision recovery.

Fixture/evidence: `KV`. KV deployed suites included in storage run; namespace/key data-plane round trips.

Local feasibility: Persistent workerd KV with metadata/expiration/list. Cloud geographical consistency cannot be reproduced.

## Pipelines.LegacyPipeline

API/reconciler review: Legacy source/transform/destination configuration, write-only credential rotation, observed reconciliation and typed deletion. Deprecated cascading force flags deliberately not exposed.

Fixture/evidence: `Pipelines/LegacyPipeline.test.ts`. Live CRUD/update/list; legacy limitations kept explicit.

Local feasibility: Legacy resource remains remote; modern pipeline runtime subset is documented separately.

## Pipelines.Pipeline

API/reconciler review: SQL definition and identity replacement, observe/get/list/create/delete, cached names and bounded consistency waits.

Fixture/evidence: `Pipelines/Pipeline.test.ts`. Live lifecycle passed; local SQL route replacement checked through deployed producer/R2 fixture.

Local feasibility: Native binding supports SQL projection/filter into local R2; unsupported SQL fails clearly.

## Pipelines.Sink

API/reconciler review: Destination/configuration/schema/format/batching. Added schema and JSON decimal/timestamp/unstructured/compression options; immutable identity and typed reads/deletes.

Fixture/evidence: `Pipelines/Sink.test.ts`. Live JSON gzip and schema fixture passed.

Local feasibility: JSON and gzip into local R2; Iceberg/Parquet/cloud delivery guarantees require external implementations.

## Pipelines.Stream

API/reconciler review: Format/schema (including inference), HTTP ingestion and binding configuration; cached name and bounded consistency polling.

Fixture/evidence: `Pipelines/Stream.test.ts`. Live CRUD/stream binding tests passed; local schema validation and pipeline delivery passed.

Local feasibility: Native send binding routes into local pipelines; external ingestion/authentication endpoints require Cloudflare.

## Queues.Queue

API/reconciler review: Added deliveryDelay, deliveryPaused and messageRetentionPeriod. Observe actual settings before patch; normalize defaults, clear omitted managed settings and preserve physical name.

Fixture/evidence: `Queues/QueueSettings.test.ts`. Actual create/update/default removal, external drift, missing-resource recovery, state-loss adoption and cloud/local pause-resume fixtures passed.

Local feasibility: Durable SQLite broker, alarms, default/per-message delay, pause/resume and expiry; producer spool details in runtime ledger.

## Queues.Consumer

API/reconciler review: Worker/pull settings and DLQ behavior. Propagate failed detach convergence, recognize missing parent and consumer, bound retries.

Fixture/evidence: `Queue/QueueConsumer.test.ts`. Live lifecycle and actual queue delivery fixtures passed.

Local feasibility: Native workerd queue events and ack/retry/DLQ; standalone cloud HTTP pull lease API is remote.

## Queues.Subscription

API/reconciler review: Source-specific subscription union, cached generated name and observed configuration/delete.

Fixture/evidence: `Queue/Subscription.test.ts`. Existing live subscription tests passed.

Local feasibility: Subscription to external Cloudflare events requires remote source; queue delivery itself is emulated.

## R2.Bucket

API/reconciler review: Bucket identity/location/storage class, CORS, lifecycle, domains/public access and locks. Added Age/Date/Indefinite prefix locks with omission-preserves/empty-clears semantics.

Fixture/evidence: `R2/Bucket.test.ts`. Storage suites plus live lock lifecycle and local lock/lifecycle fixtures passed.

Local feasibility: Native persistent object/multipart API; local lock/expiration/storage-class policies. Public DNS, managed domains and S3 auth are external control planes.

## R2.BucketEventNotification

API/reconciler review: Notification rule payloads, account/bucket/queue identity replacement, resolved-input guard and typed delete.

Fixture/evidence: `R2/BucketEventNotification.test.ts`. Create/update/replacement/list real deployments passed.

Local feasibility: Cloud R2 notification provisioning remains remote; event routing fidelity not established locally.

## R2.BucketSippy

API/reconciler review: AWS/GCS sources and destination credentials, account/bucket/jurisdiction replacement. Observe disabled state; preserve write-only credential semantics.

Fixture/evidence: `R2/BucketSippy.test.ts`. Typed disabled baseline/list checks pass; two lifecycles gated for external source credentials.

Local feasibility: Migration requires remote AWS/GCS systems; no local service clone.

## R2.DataCatalog

API/reconciler review: Enable/disable, compaction/snapshot expiration and write-only maintenance token. Observe catalog state and independently converge maintenance settings.

Fixture/evidence: `R2/DataCatalog.test.ts`. Existing deployed lifecycle/list suite included in storage verification; entitlement gates remain visible in source.

Local feasibility: Iceberg catalog/maintenance service requires separate engine, not a fake CRUD registry.

## SecretsStore.Store

Optional creation name now matches the API; an existing account-shared store retains its observed name because there is no rename operation.

API/reconciler review: Account default-store discovery, pagination and concurrent maximum-store recovery. Account changes replace. Shared store intentionally retained on stack destroy.

Fixture/evidence: `SecretsStore/SecretsStore.test.ts`. Live store discovery/list plus typed SDK probes pass; shared default store is not destructively recreated.

Local feasibility: Local persistent secrets gateway; store generation isolated by dev identity.

## SecretsStore.Secret

API/reconciler review: Name/store/account identity, value/scopes/comment. Typed create race, observed metadata no-op, clear removed comments, bounded activation, and write-only value rotation.

Fixture/evidence: `SecretsStore/Secret.test.ts`. Deployed Worker verifies creation, value rotation, comment clearing, external deletion/recreation and cleanup; list/async/local binding suites pass.

Local feasibility: Native secrets binding backed by local gateway. Undetectable out-of-band write-only value changes are not claimed observable.

## Workers.AccountSetting

API/reconciler review: defaultUsageModel and greenCompute singleton; partial desired state preserves unspecified values, captures/restores baseline, account change replaces.

Fixture/evidence: `Workers/AccountSetting.test.ts`. Actual singleton lifecycle/list tests pass with baseline restoration.

Local feasibility: Cloud account behavior remains remote.

## Workers.ObservabilityDestination

API/reconciler review: Name/dataset immutable, endpoint/headers/enabled mutable; preflight, observed state, typed delete and exhaustive list.

Fixture/evidence: `Workers/ObservabilityDestination.test.ts`. Deployed OTLP endpoint fixture and destination lifecycle/list pass.

Local feasibility: Local tracing exists; Cloudflare export control plane and preflight remain remote.

## Workers.Route

API/reconciler review: Zone/pattern/script routes, resolved input guard, identity replacement and typed deletion.

Fixture/evidence: `Workers/Route.test.ts`. Live route suites pass.

Local feasibility: Workers can be served locally; public zone routing is external.

## Workers.Subdomain

API/reconciler review: Account workers.dev singleton, baseline-preserving lifecycle and immutable scope.

Fixture/evidence: `Workers/Subdomain.test.ts`. Actual read/list/lifecycle suite passes under configured test account.

Local feasibility: Local URLs replace public workers.dev routing.

## Workers.Worker

API/reconciler review: Upload metadata and bindings, assets, preview/version traffic, domains/routes/cron, DO migrations. Added strict binding inheritance, keepBindings and full-cutover version annotations. Removed broad missing-resource catches; typed migration-tag recovery from real code10079.

Fixture/evidence: `Workers`. Actual inherited/kept secret, Worker/DO/KV/env/version/route fixtures. Full suite evidence recorded separately; some external/entitlement configurations remain gated.

Local feasibility: Workerd executes actual scripts, bindings/DOs/assets and workflow engine; cloud edge placement and control-plane scheduling are not local equivalence.

## WorkersForPlatforms.DispatchNamespace

API/reconciler review: Name identity, observed get/list/create/delete and cached-name preservation; Worker uploads use dispatch namespace metadata path.

Fixture/evidence: `WorkersForPlatforms/DispatchNamespace.test.ts`. 4 namespace cases plus dispatch worker suite passed.

Local feasibility: Local namespace registry and dispatch proxy execute workerd targets; deployed fixture verifies same-name namespace isolation, updates, deletion and missing targets. Outbound routing and production CPU/subrequest limits remain unsupported locally.

## Workflows.Workflow

API/reconciler review: Class/script identity, limits/schedules, observed PUT upsert and typed deletion. Native instance operations exercised in runtime suites.

Fixture/evidence: `Workers/Workflow.test.ts`. 13 live/local workflow cases passed, one pre-existing todo.

Local feasibility: Persistent native workflow engine; distributed execution limits are not emulated.
