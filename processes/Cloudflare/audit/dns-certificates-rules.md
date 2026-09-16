# DNS, certificate and rules resource audit

Source and SDK lifecycle review of all 36 contracts below, 2026-09-13. Passing entitlement probes are distinguished from gated lifecycle coverage. All new regressions use real deployment fixtures.

References: [Cloudflare API](https://developers.cloudflare.com/api/), [Regional hostname API](https://developers.cloudflare.com/api/resources/addressing/subresources/regional_hostnames/).

## OriginCaCertificate.OriginCaCertificate

Immutable CSR, hostname set, signing type and validity; diff now uses observed/persisted identity after adoption and normalizes CSR whitespace. GET omits CSR/validity, so cached values remain necessary. Revoked certificates are missing; hostname lookup paginates and refuses ambiguity; bounded typed revocation recovery. Live create/replacement/list/state-loss recovery passes.

Source: `packages/alchemy/src/Cloudflare/OriginCaCertificate/OriginCaCertificate.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/OriginCaCertificate/OriginCaCertificate.test.ts`.

## PageRule.PageRule

Full action/target union, priority/status default synchronization. Observed zone replacement and resolved-input guard. Actual CRUD/replacement/list cases pass; public-zone rule execution remains remote.

Source: `packages/alchemy/src/Cloudflare/PageRule/PageRule.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/PageRule/PageRule.test.ts`.

## Ssl.CertificatePack

Complete order fields plus independent validation-method and branding updates. Observed hosts/CA/validity/zone now guide replacement even without old props. Async issuance is exposed without waiting for external DCV. Typed entitlement probe/list pass; full lifecycle requires Advanced Certificate Manager.

Source: `packages/alchemy/src/Cloudflare/Ssl/CertificatePack.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/Ssl/CertificatePack.test.ts`.

## Ssl.UniversalSsl

Boolean singleton with observed no-op and captured initial value restored on destroy; zone replacement and missing-zone handling reviewed. Read/list passes. Existing mutation fixtures are gated because toggling shared-zone Universal SSL can invalidate unrelated edge certificates.

Source: `packages/alchemy/src/Cloudflare/Ssl/UniversalSsl.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/Ssl/UniversalSsl.test.ts`.

## Ruleset.Ruleset

Zone phase singleton; all SDK rule fields forwarded. Normalized rules ignore API IDs/defaults/version decorations, descriptions normalized, capture current state before PUT, clear rules on delete. Immutable phase now uses observed state. Four actual deployment/state-loss/list cases pass.

Source: `packages/alchemy/src/Cloudflare/Ruleset/Ruleset.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/Ruleset/Ruleset.test.ts`.

## Ruleset.CustomRuleset

Account custom/managed kind, phase and full nested rule surface. Observed phase/kind replacement; cached name; normalized observed rule comparison avoids redundant versions; removed description sends empty string. Typed missing reads/deletes and pagination. Live available probes/list pass; account WAF lifecycle remains plan gated.

Source: `packages/alchemy/src/Cloudflare/Ruleset/CustomRuleset.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/Ruleset/CustomRuleset.test.ts`.

## Ruleset.AccountEntrypoint

Account phase identity uses observed output after adoption, normalized desired-rule comparison and optional description. Delete empties observed phase using output identity, including absent old props. Full SDK rule surface. Existing account entitlement/list evidence passes.

Source: `packages/alchemy/src/Cloudflare/Ruleset/AccountEntrypoint.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/Ruleset/AccountEntrypoint.test.ts`.

## RegionalHostname.RegionalHostname

Zone/hostname identity plus mutable region and create-only routing. Resolved observed identity now handles adoption; adding/changing/removing explicit routing replaces with deleteFirst because POST reuses path. Region changes PATCH. Typed entitlement probe passes; actual routing replacement requires Data Localization entitlement.

Source: `packages/alchemy/src/Cloudflare/RegionalHostname/RegionalHostname.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/RegionalHostname/RegionalHostname.test.ts`.

## CustomHostname.FallbackOrigin

Full origin singleton PUT; observes origin/status and handles deletion-in-progress before no-op. Zone replacement now uses observed output. Typed absence and delete. SaaS lifecycle is entitlement gated.

Source: `packages/alchemy/src/Cloudflare/CustomHostname/FallbackOrigin.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/CustomHostname/FallbackOrigin.test.ts`.

## CustomHostname.CustomHostname

Hostname/zone observed identity replacement; full SSL settings/certificates, metadata, custom origin server/SNI mapping. Create followed by independent update-only-field sync; no broad failed-create swallowing. Optional fields use partial management. Existing SaaS quota probe passes; full issuance and customer DNS remain external.

Source: `packages/alchemy/src/Cloudflare/CustomHostname/CustomHostname.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/CustomHostname/CustomHostname.test.ts`.

## MtlsCertificate.MtlsCertificate

Complete certificate/CA/name/private-key upload. Observed account/name/CA identity, immutable PEM/key changes, paginated lookup. Same-PEM changes delete first because Cloudflare reuses IDs; new deployed rename fixture verifies final name and live certificate survival. All five actual lifecycle cases pass. Private keys are not observable.

Source: `packages/alchemy/src/Cloudflare/MtlsCertificate/MtlsCertificate.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/MtlsCertificate/MtlsCertificate.test.ts`.

## Firewall.Lockdown

Full URL/configuration/priority/description/paused mapping; observed scope now guides replacement after adoption, resolved-input guard. Typed get/delete absence and normalized mutable comparisons. Actual CRUD/replacement/list suite passes.

Source: `packages/alchemy/src/Cloudflare/Firewall/Lockdown.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/Firewall/Lockdown.test.ts`.

## Firewall.UaRule

Complete user-agent configuration/mode/paused/description surface, observed scope replacement and resolved-input guard. Actual CRUD/replacement/list suite passes; edge UA matching is a remote zone feature.

Source: `packages/alchemy/src/Cloudflare/Firewall/UaRule.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/Firewall/UaRule.test.ts`.

## Firewall.AccessRule

Target/value configuration immutable, account or zone scope distinguishes undefined zone as account identity; uses observed state on adoption. Modes/notes update in place. All actual rule suites pass.

Source: `packages/alchemy/src/Cloudflare/Firewall/AccessRule.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/Firewall/AccessRule.test.ts`.

## CustomNameserver.CustomNameserver

FQDN/nsSet issuance and glue output; account change and observed immutable state now replace. Same-name set replacement deletes first. No update API. Typed entitlement/list passes; full nameserver lifecycle needs account entitlement and registrar glue outside local runtime.

Source: `packages/alchemy/src/Cloudflare/CustomNameserver/CustomNameserver.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/CustomNameserver/CustomNameserver.test.ts`.

## KeylessCertificate.KeylessCertificate

Complete host/port/name/enabled/tunnel and certificate/bundle upload. Scope checks survive missing old certificate; PEM/bundle rotation replaces, removal of un-clearable tunnel replaces. Observed sync and typed deletion. Enterprise gate probe/list passes; external key server required.

Source: `packages/alchemy/src/Cloudflare/KeylessCertificate/KeylessCertificate.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/KeylessCertificate/KeylessCertificate.test.ts`.

## CertificateAuthorities.HostnameAssociation

Full hostname-set PUT for managed or uploaded CA; undefined certificate is a real identity. Observed scope/cert key, order-insensitive comparison, destroy clears list before dependency deletion. Actual managed/uploaded CA and replacement cases pass.

Source: `packages/alchemy/src/Cloudflare/CertificateAuthorities/HostnameAssociation.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/CertificateAuthorities/HostnameAssociation.test.ts`.

## ClientCertificate.ClientCertificate

Full issuance fields, immutable CSR/validity/zone now compared against observed output; live status distinguishes revoked/revoking. Exact CSR/validity cold lookup and typed revocation handling. Live issuance, replacement and list pass.

Source: `packages/alchemy/src/Cloudflare/ClientCertificate/ClientCertificate.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/ClientCertificate/ClientCertificate.test.ts`.

## Rules.List

All supported item unions, descriptions, bulk asynchronous item operations and kind replacement. Removed description now clears to empty string; bounded pending-operation waits and normalized items reviewed. Real lifecycle/options/removal cases pass.

Source: `packages/alchemy/src/Cloudflare/Rules/List.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/Rules/List.test.ts`.

## CustomCertificate.CustomCertificate

Certificate/key/CSR upload and rotation, bundle/geographic policy, priority, type and deploy target. Write-only deploy choice now participates in content fingerprint, so staging-to-production changes trigger PATCH. Ambiguous expiry matches no longer choose an unrelated certificate. Type/zone replace. Typed plan gate and list pass; actual edge certificate rotation requires paid entitlement.

Source: `packages/alchemy/src/Cloudflare/CustomCertificate/CustomCertificate.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/CustomCertificate/CustomCertificate.test.ts`.

## DNS.ZoneTransferTsig

Complete algorithm/name/redacted secret mapping. GET returns secret, enabling exact drift detection; typed get/delete and paginated cold lookup. Account replacement and cached name. Actual lifecycle passes.

Source: `packages/alchemy/src/Cloudflare/DNS/ZoneTransferTsig.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/Dns/ZoneTransferTsig.test.ts`.

## DNS.ZoneTransferAcl

Complete name/ipRange; account replacement, paginated cold lookup, typed absence and observed PUT. Cached-name preservation. API CIDR normalization can cause a harmless repeated PUT if noncanonical CIDR is deliberately supplied. Actual lifecycle passes.

Source: `packages/alchemy/src/Cloudflare/DNS/ZoneTransferAcl.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/Dns/ZoneTransferAcl.test.ts`.

## DNS.Dnssec

All DNSSEC flags/status, observed comparison and baseline restoration; active includes pending DS activation. Bounded status polling reduced to10 attempts. Returns asynchronous current status if still propagating. Optional flags preserve server values when omitted. Existing live fixtures pass; registrar DS installation is external.

Source: `packages/alchemy/src/Cloudflare/DNS/Dnssec.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/Dns/Dnssec.test.ts`.

## DNS.AccountSettings

All account setting and nested zone-default fields; partial management observes and PATCHes only differences. Managed-key history is mutable (removed from stables), retaining every touched field for destroy restoration. Actual baseline/updates/omission/restoration fixtures pass.

Source: `packages/alchemy/src/Cloudflare/DNS/AccountSettings.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/Dns/AccountSettings.test.ts`.

## DNS.Record

Full DNS record union including structured data, settings, privateRouting, tags/comment and defaults. Relative names normalized for lookup; duplicate name/type disambiguation by content/data/priority; observed type/zone guides replacement. Typed create collision is retained if lookup fails. Actual metadata removal, drift, recovery, adoption ambiguity and replacement fixtures pass.

Source: `packages/alchemy/src/Cloudflare/DNS/Record.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/Dns/DnsRecord.test.ts`.

## DNS.View

Full name/zones API; account replacement, observed diff, name preservation and typed deletion. Cold lookup now paginates all matches. Names are nonunique and oldest exact match requires explicit adoption. Enterprise probe/list and available fixtures pass.

Source: `packages/alchemy/src/Cloudflare/DNS/View.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/Dns/View.test.ts`.

## DNS.ZoneTransferOutgoing

Complete peer/name config and separate enable/disable toggle, default enabled. Observed singleton update, typed absence and delete. Delete no longer swallows revoked entitlement as missing state. Enterprise outgoing-transfer probes pass; full transfer lifecycle gated.

Source: `packages/alchemy/src/Cloudflare/DNS/ZoneTransferOutgoing.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/Dns/ZoneTransferOutgoing.test.ts`.

## DNS.ZoneTransferPeer

Create name then synchronize IP/port/TSIG/IXFR, retaining unspecified optional settings. Observes live settings, paginated lookup, account replacement, cached name and typed deletion. Existing real API lifecycle passes.

Source: `packages/alchemy/src/Cloudflare/DNS/ZoneTransferPeer.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/Dns/ZoneTransferPeer.test.ts`.

## DNS.ZoneTransferIncoming

Complete peers/name/refresh interval, observed singleton update, scoped identity and typed delete. No local DNS transfer server. Existing live available lifecycle/probe suite passes.

Source: `packages/alchemy/src/Cloudflare/DNS/ZoneTransferIncoming.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/Dns/ZoneTransferIncoming.test.ts`.

## DNS.Firewall

Complete upstream IPs, cache/ratelimit/mitigation/retry settings plus reverse DNS; IP-count create-only replacement. Optional fields preserve defaults; observed update-only reverse DNS sync. Typed entitlement probes pass; production recursive caching/DNS mitigation not emulated.

Source: `packages/alchemy/src/Cloudflare/DNS/Firewall.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/Dns/Firewall.test.ts`.

## DNS.ZoneSettings

Full setting/SOA/nameserver/internal DNS fields; zone replacement, partial management and baseline restoration. Managed-key history removed from stables so later-added fields restore correctly. Actual deployed tests pass; unavailable settings retain typed entitlement errors.

Source: `packages/alchemy/src/Cloudflare/DNS/ZoneSettings.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/Dns/ZoneSettings.test.ts`.

## OriginTlsClientAuth.HostnameCertificate

Complete public certificate/private-key upload. Observed scope replacement and old-secret guards prevent spurious adoption rotation. Observe tombstones as missing; typed duplicate-content recovery and bounded propagation/dependency retries. Four actual fixtures pass.

Source: `packages/alchemy/src/Cloudflare/OriginTlsClientAuth/HostnameCertificate.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/OriginTlsClientAuth/HostnameCertificate.test.ts`.

## OriginTlsClientAuth.Setting

Enabled singleton with observe-before-PUT, scope identity and captured baseline restore. Actual updates/list/restoration pass; cloud origin TLS handshake is external.

Source: `packages/alchemy/src/Cloudflare/OriginTlsClientAuth/Setting.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/OriginTlsClientAuth/Setting.test.ts`.

## OriginTlsClientAuth.HostnameAssociation

Full hostname/certificate/enabled bulk config; observed zone/hostname replacement. Omitted hostname entry is cleared on delete while retaining unrelated entries; invalid orphaned certificate association handling reviewed. Actual replacement/update/delete suites pass.

Source: `packages/alchemy/src/Cloudflare/OriginTlsClientAuth/HostnameAssociation.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/OriginTlsClientAuth/HostnameAssociation.test.ts`.

## OriginTlsClientAuth.Certificate

Complete zone certificate/private-key upload; observed scope replacement, known-only secret comparison, normalized certificate matching and typed delete. Actual create/rotation/list cases pass.

Source: `packages/alchemy/src/Cloudflare/OriginTlsClientAuth/Certificate.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/OriginTlsClientAuth/Certificate.test.ts`.

## HostnameTlsSetting.HostnameTlsSetting

All SDK TLS override values, cipher order preserved. Setting/hostname/zone identity uses observed output; list observation before PUT/delete, typed missing cleanup. Live entitlement/read evidence passes; edge TLS rollout remains service-controlled.

Source: `packages/alchemy/src/Cloudflare/HostnameTlsSetting/HostnameTlsSetting.ts`. Deployment suite: `packages/alchemy/test/Cloudflare/HostnameTlsSetting/HostnameTlsSetting.test.ts`.
