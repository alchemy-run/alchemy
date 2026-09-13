# Final 15 semantic resource audit

Sources and pinned SDK nested request interfaces reviewed for all resources below; this ledger distinguishes live deployment verification from entitlement-gated review. This suffix of service-semantic-remaining.json contains15, not16; ContentScanning.ContentScanning belongs to service agent.

Combined final run:36passed,2skipped user-auth cases,18gated,0failed;56tests15files19.5s. Log `packages/alchemy/.alchemy/log/test/2026-09-13T08-31-35-pid68600.log`. Command `timeout 240 pnpm test` with15 matching test/Cloudflare paths, `--profile testing --timeout120000`.
Followup after R2 jurisdiction and direct user-token auth probe:8passed,2skipped,4gated,0failed;14tests4files28.2s, log `08-33-05-pid69270.log` (Pages/Project,ApiToken/UserApiToken,Email/TrustedDomain,Email/BlockSender).
IAM schema regeneration reverified2passed in followup log08-29-09-pid67638 (8totalpassed4files).

SDK patches: `patches/pages/deploymentBindingNulls.manual.json` marks map value nullable for create/update preview/production binding maps. `spec-to-smithy.ts --resource pages` then `generate.ts --resource pages` applied; IAM uses same two-command pipeline. No edits to generated SDK by hand. No tsc/build/commit/push by child.

Exact available gates: AccountCreationForbidden code1002; Argo NotAuthorized code1015; SpectrumProtocolNotAvailable; AdvancedCertificateManagerRequired code1450; EmailSecurityNotEntitled/Forbidden; user list direct Unauthorized: "Unauthorized to access requested resource". Existing fixture gate flags: CLOUDFLARE_TENANT_TEST, CLOUDFLARE_TEST_USER_TOKENS, CLOUDFLARE_EMAIL_SECURITY, CLOUDFLARE_EMAIL_SECURITY_DOMAIN, entitlement-specific zone IDs for Spectrum/ACM/Argo, CLOUDFLARE_TEST_PAGES_LIST. Test logs preserve exact probe outputs and existing SDK patches hold vendor matchers. Gated test count is not a feature-verification count.

Official API references reviewed: https://developers.cloudflare.com/api/resources/pages/subresources/projects/methods/edit/ ; https://developers.cloudflare.com/api/resources/user/subresources/tokens/methods/update/ ; https://developers.cloudflare.com/api/typescript/resources/accounts/subresources/tokens/methods/update/ . Remaining API field comparisons used pinned SDK and checked-in official API docs converted into it.

Local feasibility is detailed per resource. No fake successful local control-plane resources added. Pages Project/Deployment dedicated local emulation remains a limitation; existing Worker/Assets runtime provides corresponding execution primitives but does not emulate Git integrations, hosted builds, or Cloudflare project control-plane APIs.

## Spectrum.Application

All create/update mutable top-level fields and nested DNS/origin DNS/edge IP branches compared. Fixed observed zone replacement for adoption, originDns ttl/type-only updates, explicit false/off defaults, observed edgeIps/virtualNetworkId outputs, and delete-first replacement to reset omitted managed TLS/edge IP/network settings where request lacks nullable reset. Paginated identity lookup and typed delete preserved. Typed SpectrumProtocolNotAvailable probe/list passed; enterprise origin DNS/edge routing updates reviewed, gated.

## Account.Account

Compared create name/type/unit and update name/type/settings/managedBy. Added missing managedBy parent organization ID/name and dirty detection. Type/unit remain creation identity; optional settings intentionally unmanaged on omission, documented. Names nonunique so no unsafe cold name adoption; ID-based read/delete preserved. Actual read/list + AccountCreationForbidden code1002 probe passed. Tenant creation/update/delete and managedBy changes remain gated.

## Account.Member

Compared email/roles/policies/status and nested permission/resource group references. Replaced unsafe Input<Props> cast diff with isResolved narrowing, account and observed email/status identity; accepted-to-pending replacement now deletes first to allow reinvitation at same email. Paginated lookup, missing-member recovery, typed duplicate adoption retained. Actual invite/update roles/email replacement/out-of-band deletion recovery/list/delete passed. Policy-only enterprise branch and accepted reinvitation not live verified.

## ApiToken.UserApiToken

Compared complete token name/policies/IP condition/notBefore/expiresOn/update status. Added missing active/disabled/expired status; disabled create applies update after one-time secret capture; omission reactivates. No cold lookup since plaintext token cannot be recovered from GET. Preserves redacted token value on update; typed deletion. Replaced unconditional skipped suite with user-auth env gate and added status lifecycle fixture. Direct SDK list probe confirms Unauthorized under current scoped token; user-token writes gated.

## ApiToken.AccountApiToken

Same full policy/condition/validity/status surface as user token plus account scope. Added status create-then-update and reset active on omission. Existing account identity replacement and one-time secret preservation retained. Removed blanket skipped suite: real create/update/noop/list/delete and new disabled-create→status-omission→active test all pass; token secret stays unchanged on update.

## Argo.SmartRouting

API is singleton value on/off; enabled maps full mutable surface. Observed baseline capture, default true, zone replacement and restore-on-delete reviewed. Typed NotAuthorized code1015 subscription probe/list passed; actual paid enable/restore fixture gated. Cloud edge route selection cannot be reproduced by workerd.

## Argo.TieredCaching

Complete singleton value surface, observed baseline capture and enabled/default true updates. Added typed ZoneNotFound catch to GET read/delete paths (PATCH only declares InvalidObjectIdentifier). Actual enable/update/default/list/restore fixtures passed. Multi-colo cache hierarchy is Cloudflare control-plane behavior outside workerd.

## Pages.Project

Compared full POST/PATCH top-level and nested deployment config/source config. Added source GitHub/GitLab repository triggers/config; webAnalyticsTag/webAnalyticsToken; AI/browser/Analytics Engine/DO/Hyperdrive/mTLS/Queue/service/Vectorize bindings; alwaysUseLatestCompatibilityDate/buildImageMajorVersion/limits/usageModel/wranglerConfigHash. R2 now accepts compatible string or {name,jurisdiction}. Typed map null SDK patch supports removing stale binding keys without erasing nested types. Observed dirty comparison includes every new field and desired-only nested source fields; persisted old props detect hidden secret changes. Existing project settings omission is documented unmanaged; explicit empty maps remove bindings. Actual lifecycle/name replacement/list plus new real EU R2 binding, queue binding removal, analytics tag and preview build/compatibility settings update pass. API rejects latest compatibility date true in production (typed BadRequest), fixture corrected to preview and property documented. Source Git integration and paid bindings remain reviewed-only. Local Pages Git build/deployment control plane absent; equivalent workerd Worker/Assets execution exists but this is not full Pages project emulation.

## Pages.Domain

Compared API create{name}, get/delete path project/name, patch no body (validation retry). All fields covered; immutable project/name/account identity, scoped paginated inventory and idempotent parent/child not-found deletion reviewed. Actual attach/detach/name replacement fixtures passed; accountwide list fixture gated by CLOUDFLARE_TEST_PAGES_LIST. Real DNS/TLS validation cannot be emulated by workerd.

## Email.TrustedDomain

All pattern/isRegex/isRecent/isSimilarity/comments fields wired, paginated natural lookup and typed deletion retained. Added account identity guard and omission reset of comments to empty; booleans already reset false. Extended actual lifecycle fixture with comment removal, gated by EmailSecurityNotEntitled; live list passed (empty under entitlement). No local inbound Email Security scanning appliance.

## Email.BlockSender

All pattern/patternType/isRegex/comments fields exposed. Added account identity guard and omitted-comments clear; paginated recovery/typed missing delete retained. Extended actual deployed fixture with removal at same logical ID. List passed; lifecycle gated by EmailSecurityNotEntitled. Cloudflare Email Security filtering control plane absent locally.

## Email.SendingSubdomain

API create has only zone/name, no mutable update endpoint. Fixed resolved observed zone/name replacement during adoption. Natural name recovery, duplicate-create rescan, paginated inventory and missing delete reviewed; readiness poll bounded centrally to10x5s. Four deployed fixtures remain gated behind scoped email routing capability because unauthenticated zone route returns Forbidden. Sending domain DNS/DKIM provisioning needs actual Cloudflare DNS, not workerd.

## Email.Domain

Compared full patch settings including allowed delivery modes/drop dispositions/folder/integration/IP restrictions/lookback/TLS/transport/domain/regions. Added missing regions and in-place API-supported domain rename; removed stable domain and rename replacement. Added account guard. Existing dashboard onboarding required (no create API), owned UUID observation and paginated cold lookup preserved; delete offboards. Other omitted settings intentionally unmanaged. Read/list passed; lifecycle needs explicit sacrificial onboarded Email Security domain and is gated.

## Acm.CustomTrustStore

Create API accepts zone+PEM only, no mutable update operation. Certificate normalization/zone replacement, paginated certificate cold recovery, pending-deletion filtering and observe-before-delete with typed missing errors reviewed. AdvancedCertificateManagerRequired code1450 probe/list passed; root-CA creation/replacement live fixtures gated. Trust verification at Cloudflare origin edge not local workerd control plane.

## Acm.TotalTls

Full mutable API enabled+certificateAuthority exposed (validityPeriod response-only). Singleton baseline capture, desired-only optional CA, zone replacement and restore-on-delete reviewed; typed NoStateChange refresh and PreviousJobInProgress capped10x3s. Actual read/list + AdvancedCertificateManagerRequired probe passed; paid enable/CA/restore gated. Certificate issuance and DNS edge rollout require Cloudflare.
