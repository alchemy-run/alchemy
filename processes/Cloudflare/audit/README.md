# Cloudflare API, reconciler and local-runtime audit

Audit date: 2026-09-13. [resources.json](resources.json) inventories **241 existing resource contracts**, each with an explicit semantic review, existing source/test paths and the detailed findings below. The inventory excludes provider implementation helpers; Container functions, Worker bindings and runtime capabilities are discussed alongside their backing resources.

The review compares desired-state fields, nested request types and lifecycle operations with the pinned distilled SDK and Cloudflare documentation. It covers observed-state reconciliation, adoption without old props, cached names, identity replacement, omitted options, write-only values, pagination, typed absence, ownership conflicts, bounded retries and idempotent cleanup. Operational/data-only API calls are distinguished from persistent resource settings. This is not a claim that every Cloudflare API endpoint is a resource or that every race and configuration combination was deployed.

## Findings by scope

| Ledger | Resource contracts |
| --- | ---: |
| [Core resources](core.md) | 24 |
| [Service resources](services.md) | 79 |
| [DNS, certificates and rules](dns-certificates-rules.md) | 36 |
| [Additional services](additional-services.md) | 17 |
| [Zero Trust](zero-trust.md) | 36 |
| [Network and IAM](network-iam.md) | 24 |
| [Accounts, Pages and related services](accounts-pages.md) | 15 |
| [Media and schema resources](runtime-resources.md) | 8 |
| [Vectorize and runtime bindings](runtime.md) | 2 |

[Containers](containers.md), [queue buffering](queues.md), [Pipelines local execution](pipelines-local.md) and [Worker readiness](runtime-readiness.md) describe the corresponding deployed fixtures and limits.

## Deployment evidence

New provider regressions use the repository's `test.provider` lifecycle and real deployed fixtures, including out-of-band SDK mutations to exercise recovery. New local-runtime edge cases execute real workerd. No mocked reconciler suite or `QueueReconcile.test.ts` is included. The adjacent result JSON files record commands, per-run results, typed entitlement errors and reasons for SDK patches. Historical `.audit` and `.alchemy/log` paths identify local execution logs; those scratch logs are intentionally not part of the PR.

Representative completed runs include 104 Zero Trust passes with 18 gates; 37 network/IAM passes with 27 gates; 36 accounts/Pages-related passes with 18 gates and two skips; 20 media/schema passes with one entitlement todo; 31 certificate passes with 16 gates; 21 DNS passes with two gates; 26 rules/firewall passes; and 32 combined retry regression passes. The final hung-container regression passed without retries through real Docker/workerd, and the final combined native workerd regression passed all 17 cases. Runtime runs include 131 R2/Vectorize/Stream passes, 34 native queue cases and three deployed queue-buffering fixtures. Counts across repeated runs overlap and must not be added into a total.

Tests are bounded by a 240-second hard process wall, with bounded per-test timeouts and retry policies. Earlier broad parallel runs exposed Worker hostname propagation failures and a queue shim timeout (the exact isolated shim test subsequently passed without retries); the readiness ledger records what was reproduced and rerun rather than treating all failures as infrastructure noise. Async Vectorize metadata materialization remains explicitly gated after actual delays exceeded the bounded test budget.

## Local behavior and limits

Implemented or expanded local behavior includes Vectorize storage/query/filtering and metadata generations; R2 locks, lifecycle expiration and storage classes; durable queue producer buffering/settings; Analytics Engine storage and SQL subset; shared rate-limit counters; Images transforms/text/animation; Stream direct uploads; dispatch namespace routing; Pipelines JSON/gzip-to-R2 processing; and Flagship targeting for Workers and Actions.

The runtime ledger explicitly records remaining differences: cloud replication/placement/quotas, production Vectorize approximate indexing and async latency, full ClickHouse SQL, arbitrary Pipeline SQL/Parquet/Iceberg, Stream transcoding/HLS/TUS, several Images transformation modes and exact Flagship percentage membership. Account security, DNS delegation, certificates, network routing and enterprise policy enforcement depend on external services and are not represented by nonfunctional local placeholders.

Plan-gated resources retain typed rejection probes and opt-in deployment fixtures. New fields requiring Enterprise entitlement, external identity providers, databases, zones or global shared-account changes were reviewed but could not all be exercised on this account. A skipped lifecycle is not evidence of API feature correctness; consult each resource note before relying on an unexercised configuration.

## SDK maintenance

Request/response mismatches and precise API error tags are fixed in distilled's maintained Smithy patches or the Containers manual specification. The parent change pins supporting SDK commit `e6d5e8ffa` on `alchemy-run/distilled` branch `codex/cloudflare-completeness-audit`. For patched generated services, apply `bun scripts/spec-to-smithy.ts --resource SERVICE` and then `bun scripts/generate.ts --resource SERVICE` from the Cloudflare SDK package. Running the generator alone does not apply the patch input. Consumers retain typed SDK requests/errors instead of compensating with untyped response casts or generic error suppression.

## Final workspace checks

The combined workspace passed `pnpm exec tsc -b`; the Cloudflare runtime package built successfully. `pnpm lint:providers`, `pnpm docs:gen`, `pnpm docs:check-jsdoc` and the final staged whitespace check also passed.
