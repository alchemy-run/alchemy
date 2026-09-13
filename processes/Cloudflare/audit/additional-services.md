# Additional service resource audit

Full source lifecycle and SDK review, 2026-09-13. New regression coverage uses actual deployments. Entitlement probes are not full lifecycle verification.

## Zone.CustomNameservers

Reviewed full enabled/nsSet singleton against zones SDK; observed zone identity, baseline capture, omitted set preserves observed choice, destroy restores initial toggle/set. Typed missing-zone cleanup and missing original set handling. Available read/entitlement tests pass; full custom-nameserver activation requires entitlement.

Source: `packages/alchemy/src/Cloudflare/Zone/CustomNameservers.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/Zone/CustomNameservers.test.ts`.

## Zone.Hold

Added missing PATCH holdAfter scheduling input. Scheduled temporarily inactive holds remain readable; removing schedule reactivates the hold, subdomain default resets false. Typed patch disappearance recreates before applying schedule. Full planned deployment fixture includes scheduling/reactivation, gated on Enterprise zone; actual probe/list passes.

Source: `packages/alchemy/src/Cloudflare/Zone/Hold.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/Zone/Hold.test.ts`.

## LoadBalancer.Monitor

All monitor fields compared with SDK, including protocol, headers, consecutive health thresholds, path/codes/body and zone override. Omitted optional settings intentionally preserve service values. Cached description now survives omission; typed dependency retry capped. Plan entitlement/list fixtures pass.

Source: `packages/alchemy/src/Cloudflare/LoadBalancer/Monitor.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/LoadBalancer/Monitor.test.ts`.

## LoadBalancer.MonitorGroup

All member flags and monitor IDs mapped with explicit defaults. Observed membership and description converge; cached description preserved, pagination and typed bounded dependency deletion. Entitled lifecycle remains gated; actual probe/list passes.

Source: `packages/alchemy/src/Cloudflare/LoadBalancer/MonitorGroup.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/LoadBalancer/MonitorGroup.test.ts`.

## TokenValidation.Rule

Complete action/expression/title/description/selector plus PATCH-only position. Full observed mutable comparison, explicit enabled/description defaults, sorted selector sets, cached title and zone identity. Position deliberately reapplied when supplied. Typed entitlement/list passes; actual JWT rule execution gated.

Source: `packages/alchemy/src/Cloudflare/TokenValidation/Rule.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/TokenValidation/Rule.test.ts`.

## Flagship.App

Full name CRUD; observed ID and paginated name recovery; cold foreign match now Unowned. Generated name preserved after omission; list hydrates ghost rows before returning them. Actual CRUD/list fixtures pass. Local evaluation implementation tracked in runtime ledger.

Source: `packages/alchemy/src/Cloudflare/Flagship/App.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/Flagship/App.test.ts`.

## Flagship.Flag

Full variation/rule nested clauses/operators/rollout/type SDK surface. Explicit type now participates in no-op decision; description removal clears; omitted key preserves deployed identity. Cold match is Unowned. New real fixture clears description/rules, restores enabled default, and checks same flag key. Actual lifecycle/replacement/recovery/list passes.

Source: `packages/alchemy/src/Cloudflare/Flagship/Flag.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/Flagship/Flag.test.ts`.

## UrlNormalization.UrlNormalization

Full scope/type PUT, default incoming/cloudflare restored on omission, observed equality avoids writes; delete invokes true API reset, missing-zone handling and observed scope replacement. Four actual singleton tests pass.

Source: `packages/alchemy/src/Cloudflare/UrlNormalization/UrlNormalization.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/UrlNormalization/UrlNormalization.test.ts`.

## LeakedCredentialCheck.LeakedCredentialCheck

Enabled defaults true, observed singleton state and initial snapshot restoration. Zone scope replacement. Actual enable/update/restore/list cases pass. Credential corpus and edge matching require Cloudflare.

Source: `packages/alchemy/src/Cloudflare/LeakedCredentialCheck/LeakedCredentialCheck.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/LeakedCredentialCheck/LeakedCredentialCheck.test.ts`.

## LeakedCredentialCheck.Detection

All username/password expression fields, paginated exact matching and observed update. Missing product entitlement is not proof of deletion: removed disabled-product swallowing from owned read/delete. True DetectionNotFound remains idempotent. Real available CRUD/list fixtures pass.

Source: `packages/alchemy/src/Cloudflare/LeakedCredentialCheck/Detection.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/LeakedCredentialCheck/Detection.test.ts`.

## LogsControl.CmbConfig

Full regions/out-of-region access API upsert and explicit account override. Read/delete now propagate authorization loss instead of silently discarding tracked config; only enumeration treats unavailable entitlement as empty. Typed actual probe/list passes; Compliance entitlement gates full lifecycle.

Source: `packages/alchemy/src/Cloudflare/LogsControl/CmbConfig.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/LogsControl/CmbConfig.test.ts`.

## LogsControl.RetentionFlag

Full flag singleton; observed no-op, initial baseline preserved/restored, zone replacement and missing-zone cleanup. Typed entitlement/list cases pass; Logpull storage behavior remains remote.

Source: `packages/alchemy/src/Cloudflare/LogsControl/RetentionFlag.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/LogsControl/RetentionFlag.test.ts`.

## MagicCloudNetworking.CloudIntegration

All AWS/Azure/GCP credential references and cloud type mapped; observe/get/name discovery then create+sync. Added effective account replacement and preserved cached friendlyName. Cloud type immutable. Forwarded header is transport context, not resource desired state. Actual entitlement/list passes; full topology needs cloud account integration.

Source: `packages/alchemy/src/Cloudflare/MagicCloudNetworking/CloudIntegration.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/MagicCloudNetworking/CloudIntegration.test.ts`.

## MagicCloudNetworking.OnRamp

Full SDK topology/create/patch fields and deletion mode. Added account replacement, preserved cached name, returned region and used observed region/ASN to enforce immutable replacement during adoption. Optional attached sets can be cleared with []; omitted optional topology preserves observation. Actual entitlement/list passes; external cloud topology lifecycle gated.

Source: `packages/alchemy/src/Cloudflare/MagicCloudNetworking/OnRamp.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/MagicCloudNetworking/OnRamp.test.ts`.

## MagicCloudNetworking.CatalogSync

All destination/update mode/policy/name/description and deleteDestination fields. Added account replacement and cached-name preservation; destination type immutable, deletion mode refreshed in output and not stable. Actual entitlement/list passes; external cloud discovery required for full lifecycle.

Source: `packages/alchemy/src/Cloudflare/MagicCloudNetworking/CatalogSync.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/MagicCloudNetworking/CatalogSync.test.ts`.

## ManagedTransforms.ManagedTransforms

Full catalog ID-to-enabled request/response mapping, conflict outputs, partial management and initial snapshots. Added managed-ID history across deployments so removed props still restore on destroy. Extended actual fixture verifies removing a newly-managed field then restoring it. Removed transient-auth list skip; all four deployed fixtures pass.

Source: `packages/alchemy/src/Cloudflare/ManagedTransforms/ManagedTransforms.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/ManagedTransforms/ManagedTransforms.test.ts`.

## AI.SearchNamespace

Full name/description CRUD, reserved default namespace read-only/retained, output identity/account replacement, typed create-race recovery and paginated list. Description null clears; missing-on-update recreate. Independent actual namespace lifecycle refresh recorded in evidence.

Source: `packages/alchemy/src/Cloudflare/AI/SearchNamespace.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/AI/SearchNamespace.test.ts`.

Flagship follow-up: App and Flag now have offline local providers, with native/Effect Workers and Actions exercised through deployed fixtures. App cold lookup validates stale list rows against GET before returning Unowned. Local rollout membership uses a documented approximation because Cloudflare does not publish its hash algorithm; see `runtime.md`.
