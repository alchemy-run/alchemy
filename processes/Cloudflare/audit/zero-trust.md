# Zero Trust resource audit

Reviewed 36 resources against the pinned `submodules/distilled/packages/cloudflare/src/services/zero_trust.ts` (de878484911b4aba41519a3c5103c16d036c1b31), current source/providers, existing patches, lifecycle tests, and official API documentation. The accompanying `zero-trust-scan.json` inventories create/update request fields, including wildcard SDK imports and property-access operations. Static field parity is not proof that every API combination works. All added tests use deployed resources and real SDK verification; the temporary mocked HTTP suite was removed following the user's correction.

## API and lifecycle coverage by resource

| Resource | API coverage / changes | Verification and remaining constraints |
| --- | --- | --- |
| Access.Application | Added 29 SDK-typed application options: cookie flags, CORS, custom denial/pages, launcher styling/footer, MFA, SaaS/SCIM, hostnames/target criteria, isolation, WARP authentication and redirects. Create/update wire them and compare observed settings. DELETE only suppresses typed application-not-found. Normalize omitted `allowIframe:false` reported by live API. | Live self-hosted CRUD, OAuth configuration, inline/reusable policy transitions, cold recovery, list, advanced cookie/CORS updates. WARP case returns early without Google IdP env. All specialized SaaS/SCIM/MFA combinations require their external service setup and are statically reviewed, not live verified. API rejects CORS headers together with preflight bypass. |
| Access.Bookmark | All legacy create/update fields present. Failed list/discovery no longer becomes absence. | Live missing-ID and legacy API probe; lifecycle gated on CLOUDFLARE_TEST_ACCESS_BOOKMARKS. Legacy API rejects with AccessBookmarkNotFound; modern Application `type:bookmark` remains available. |
| Access.Certificate | Name, PEM, associated hostnames covered; certificate material immutable/replacement. Discovery errors propagate. | Live missing certificate/probe; lifecycle gated by AccessCertificateQuotaExceeded code12130, maximum number of certificates reached. |
| Access.CustomPage | Name, HTML, app count/custom type fields present; listing errors propagate. | Live read/probe; write gated AccessCustomPagesNotEntitled HTTP403 code12133, account does not have permission for custom pages. |
| Access.Group | Name/include/exclude/require and account/zone scope present. Discovery errors propagate. | Live create/update/rename/list and policy integration pass. |
| Access.IdentityProvider | SDK-typed discriminated configs and scoping cover provider variants; SAML certificate-set ID supported. `samlCertificateSet` is server certificate details, not desired credentials. `readOnly` is intentionally not exposed: it locks provider API mutation/deletion and conflicts with managed lifecycle. | Live OIDC/account/zone CRUD, type/scope replacements, secret and certificate-set scenarios in existing suite. Server read-only objects cannot be fully lifecycle-managed. |
| Access.InfrastructureTarget | Hostname, IPv4/IPv6, virtual network and port fields present. | Live deployed list and target lifecycle pass. |
| Access.KeyConfiguration | Key rotation interval singleton settings present. | Live capture/restore and singleton list pass; signing-key operational rotate is an action, not persistent desired state. |
| Access.McpPortal | Added complete `servers` request shape on create/update and drift comparison. Other portal name/hostname/IDP options already present. | Live existing portal CRUD/list pass; nonempty external server integration is not live verified. |
| Access.Organization | Added deny-unmatched flags/exempt zones and MFA configuration/PIV/all-apps options. Existing login/branding/WARP/session settings present. | Live singleton read/list; mutations gated by CLOUDFLARE_TEST_AUTH_DOMAIN to preserve active team organization. Delete intentionally does not destroy team identity. New global settings statically verified only. |
| Access.Policy | Added approvalGroups, connectionRules, isolationRequired, mfaConfig, purposeJustificationPrompt. Successful exhaustively paginated list now establishes missing IDs for read/delete; auth/transport failures propagate. | Live CRUD/adoption/list, purpose prompt updates, out-of-band deletion and recreation. Approval/MFA/RDP/isolation configurations statically wired but require suitable apps/services for enforcement tests. |
| Access.ServiceToken | Duration/name/client-secret rotation covered. Discovery errors propagate. | Live creation, duration update, rotation, list/deletion pass; returned secrets stay redacted. |
| Access.Tag | Name identity and replacement behavior match tag API. | Live creation/rename replacement/list pass. |
| Devices.CustomProfile | Added dnsSearchSuffixes, globalAcceleration, virtualNetworks through typed create/patch; object comparison ignores nullish field noise. Existing full device settings/include/exclude/fallback management present. | Live custom CRUD/list; suffix object create and clear tested. External acceleration/network effects require WARP clients. |
| Devices.DefaultProfile | Same three settings added. Observe complete GET response include/exclude/fallback collections; no longer convert failed auxiliary list calls to empty settings. | Live singleton list; capture/restore mutations gated CLOUDFLARE_TEST_DEVICES=1. New global settings not mutated on shared account. |
| Devices.DexTest | SDK probe data, name, enabled and interval fields present. | Live entitlement/read probes; lifecycle gated Forbidden code11007 dex.api.entitlements.missing. |
| Devices.ManagedNetwork | Name and TLS config fields cover API's TLS managed-network type. | Live CRUD/list pass. Real network classification requires client access to configured TLS endpoint. |
| Devices.PostureIntegration | Service-specific config, interval/name/type covered. | Live rejection/read probe; external credentials lifecycle gated InvalidPostureIntegrationConfig code2046 invalid posture integration request: invalid credentials. |
| Devices.PostureRule | All typed posture input/match/expiration/schedule fields present; changing type replaces. | Live create/update/type replacement/list pass. Actual posture evaluation needs enrolled clients. |
| Devices.Settings | Account device settings SDK object covered. | Live capture/restore, singleton list pass. |
| Dlp.Entry | All aliased CreateDlpEntryCustomRequest=CreateDlpEntryRequest fields present. Description now participates in drift and clears on removal. | Live list/read only; write lifecycle gated Forbidden code3314. Description removal code reviewed; not live exercised on current account. |
| Dlp.Profile | Added aiContextEnabled, contextAwareness, dataClasses, dataTags, sensitivityLevels, sharedEntries. Shared entries compare actual sharedEntries; object sensitivity IDs and entry descriptions compared. Existing entry IDs preserved; description removal sends null. | Live list and entitlement probe. Added actual deployment fixture for context toggling and inline description removal behind CLOUDFLARE_TEST_DLP; skipped on this account. |
| Gateway.Certificate | Generation, validity/activation fields and replacement lifecycle reviewed. | Basic activation/deactivation/read tests pass; replacement gated to avoid 3-certificates-per-24h quota. Existing quota helper may return early when exhausted. |
| Gateway.Configuration | Full SDK configuration object and singleton capture/restore covered. | Live capture/restore/list pass. |
| Gateway.List | Name, type, description and all item shapes covered; type replacement. | Live CRUD, item updates, type replacement pass. |
| Gateway.Location | Added maxTtl create/update/diff; removing override sends inherit matching vendor update semantics. Existing DNS endpoints/networks/client settings covered. | Live TTL create/update/removal, CRUD, out-of-band delete recovery/list pass. |
| Gateway.Logging | Full SDK settings and singleton reset semantics reviewed. | Live capture/restore and list pass. |
| Gateway.ProxyEndpoint | Name, kind, IP/subdomain/auth and subnet fields reviewed. | Live supported endpoint CRUD/list; ip-kind typed entitlement probe passes. |
| Gateway.Rule | Added expiration and schedule. Read/delete use successful exhaustive list evidence of absence and preserve failures. | Live DNS schedule create/update plus out-of-band deletion recovery; list pass. Expiration and non-DNS actions statically wired; full traffic enforcement not exercised. |
| RiskScoring.Integration | All API tenant/reference/active fields present. Discovery now exhausts list pages when locating tenant URL. | Live read/probe; create/update gated Forbidden HTTP403 code3314 and external Okta tenant. |
| Tunnel.Configuration | Full typed ingress and originRequest configuration; delete suppresses only TunnelNotFound. | Live tunnel config replacement/reset pass. |
| Tunnel.HostnameRoute | Hostname, tunnel, description fields present. | Live CRUD/list pass. |
| Tunnel.Route | CIDR, tunnel, comment, virtual-network fields present. Read/delete use exhaustive list identity; soft-deleted routes ignored; discovery failures propagate. | Live CRUD/update/adoption/list pass. A concurrent delete after successful observation can still return API failure; retry discovers absence. |
| Tunnel.Tunnel | Configuration source, name, secret and typed originRequest options including Access validation present. Narrow missing-token/tunnel catches and discard soft-deleted records before reuse. | Existing fixture/live lifecycle, config, list and remote API capability tests pass. Running cloudflared traffic not exercised. |
| Tunnel.VirtualNetwork | Name/comment/default-network settings present. SDK create `isDefault` is an alias of supported `isDefaultNetwork`, not another feature. | Live CRUD/update, missing recovery/list pass. |
| Tunnel.WarpConnector | Added HA creation/replacement and redacted tunnel-secret update. Omitted HA compares as false. | Existing connector CRUD/list pass. New HA/secret paths statically wired; actual external WARP Connector enrollment/traffic not exercised. |

All resources were read and compared, not merely inventoried. Account-change replacement guards are coordinator-owned. Existing create recovery catches were checked separately from unsafe missing-resource catches: they re-observe deterministic identity and otherwise propagate failure, rather than silently returning absence.

## Local execution feasibility

- **Access (all13):** Central authentication sessions, IdP OAuth/SAML, mTLS, policy enforcement, MCP portal and team identity require Cloudflare edge and external identities. There is no workerd resource binding implementing these security services. `cloudflare-runtime/core/remote-bindings/Access.ts` authenticates requests to real Access endpoints; it is not a local authorization emulator.
- **Devices (all7):** These configure enrolled WARP clients, external posture providers, and device network probes. Workerd has no enrolled-device model, posture collection or OS tunnel interface; local execution cannot faithfully verify policy effects.
- **Dlp (both):** Profiles and detection are managed security-service controls with vendor models and entitlement, not local Worker storage. Local regex matching alone would not emulate the DLP service's AI/context/data-class features.
- **Gateway (all7):** Account Gateway DNS, network filtering, TLS interception and client routing run in Cloudflare's network. Workerd execution cannot emulate their account-wide effects. Tests deploy real configuration records.
- **RiskScoring:** Requires an external identity provider tenant and Cloudflare risk signals. No faithful standalone emulator available.
- **Tunnel (all6):** Cloudflare tunnel routing and connector enrollment require actual control-plane and agents. Existing `ReadWriteTunnelLocal` uses real API credentials/HTTP; its passing test proves remote API access, not local tunnel networking. A local reverse proxy would not reproduce virtual-network routes/WARP behavior.

No fake local providers were introduced for these families. This is a feasibility assessment, not a claim of locally verified security equivalence.

## Verification evidence

Initial complete family run (before final added live regressions): `timeout 240 pnpm test test/Cloudflare/Access test/Cloudflare/Devices test/Cloudflare/Dlp test/Cloudflare/Gateway test/Cloudflare/RiskScoring test/Cloudflare/Tunnel --profile testing --timeout 90000` — 112 passed, 17 todo, 0 failures, 42.7s. This run contained the subsequently removed 12 mocked cases, so it must not be presented as 112 real deployment cases. Log: `packages/alchemy/.alchemy/log/test/2026-09-13T07-27-18-pid7733.log`.

New live Location TTL, Policy prompt/recreation, Rule schedule/recreation passed in `2026-09-13T07-33-02-pid12961.log`. Initial fixture mistakes (string DNS suffix instead of object, incompatible CORS + preflight bypass) were caught by the live API and corrected. Corrected CustomProfile suite: 2 passed, `2026-09-13T07-33-42-pid13250.log`. Final combined run recorded below when complete.

No SDK patches were needed. No agent typecheck/build/commit/push was run. Coordinator runs authoritative workspace checks.

## Official references

- [Access application API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/)
- [Reusable policy API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/policies/methods/create/)
- [Device default policy and DNS suffix objects](https://developers.cloudflare.com/api/resources/zero_trust/subresources/devices/subresources/policies/subresources/default/)
- [Custom DLP profile API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/dlp/subresources/profiles/subresources/custom/methods/create/)
- [Gateway Location update TTL reset semantics](https://developers.cloudflare.com/api/resources/zero_trust/subresources/gateway/subresources/locations/methods/update/)
- [Network route API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/networks/subresources/routes/)
- [WARP Connector creation API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/warp_connector/methods/create/)

Final family verification (mock suite removed): **104 passed, 18 todo, 0 failures**, 122 tests in 39 files, 37.9s. Log `packages/alchemy/.alchemy/log/test/2026-09-13T07-36-04-pid14943.log`. Additional strengthened Policy absence assertions and already-deleted destruction: **5 passed**, log `packages/alchemy/.alchemy/log/test/2026-09-13T07-36-46-pid15677.log`. These totals include existing read/probe tests and the WARP enrollment early-return case; they are not a claim that every test deployed a resource.
