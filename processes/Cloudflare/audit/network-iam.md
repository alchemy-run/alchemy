# Semantic audit: 24 control-plane resources

Final verification: 37 passed, 27 gated, 0 failed, 24 files, 24.8 seconds. Real deployed fixtures; no mocks. Log: `packages/alchemy/.alchemy/log/test/2026-09-13T08-22-52-pid63776.log`. Command: `timeout 240 pnpm test test/Cloudflare/{Iam,Addressing,ResourceSharing,MagicTransit,DdosProtection}/*.test.ts --profile testing --timeout 120000` from packages/alchemy (expanded paths).

Local feasibility: these resources configure Cloudflare account authorization, cross-account resource grants, BYOIP routing/advertisement, enterprise network appliances/tunnels, and edge DDoS enforcement. A workerd runtime cannot emulate those account control planes or physical networking; no fake local provisioning added. IAM resources are actual cloud IAM, distinct from local Worker binding capabilities.

Evidence: pinned SDK request/response + nested interfaces reviewed. Official API references: https://developers.cloudflare.com/api/resources/iam/subresources/resource_groups/methods/update/ , https://developers.cloudflare.com/api/resources/resource_sharing/methods/update/ , https://developers.cloudflare.com/api/resources/addressing/subresources/address_maps/methods/edit/ , https://developers.cloudflare.com/api/resources/magic_transit/subresources/gre_tunnels/methods/update/ .

IAM SDK correction: create/get/update/list ResourceGroup scope responses return a single {key,objects} object (live evidence log08-22-09-pid63332); RFC6902 service patches correct target. Regenerated IAM only. No consumer casts hiding the mismatch.

Gates: MagicTransitNotOnboarded code1012, MagicWanUnauthorized, sharing Forbidden, advanced TCP entitlement and BYOIP ownership/external account requirements. Exact captured probe values remain in existing test constants/SDK patches. These gates mean reviewed fields are not all live-verified.

## Iam.ResourceGroup

Compared create/update/get/list scope key and object keys; all mutable inputs exposed. Fixed account replacement and SDK scope response (actual object, vendor model array) on all four operations. Existing name lookup/observe-before-create and idempotent delete retained. Actual deployed create/update/list/delete plus out-of-band scope drift restored on subsequent rename passed. Unchanged-props deployment alone does not trigger provider reconcile in engine.

## Iam.UserGroup

Compared name and nested policies/access/permission-group IDs/resource-group IDs; full mutable API fields exposed. Added account replacement guard. Actual lifecycle/list and out-of-band policy removal followed by rename restored desired policy passed; no local IAM enforcement emulator.

## Iam.UserGroupMembership

Membership is immutable user/account-member + group tuple; added observed identity/account replacement guard for adoption and bounded group propagation retry. Actual deployed group replacement, list and teardown passed.

## ResourceSharing.Share

Compared name, kind, resources(type/id/account/meta), recipients(account/org). Cold reconcile now looks up by name; lookup paginates all pages. Inline accountId alias maps canonical recipientAccountId; resource owner participates identity comparison. Read/list and typed write Forbidden probe passed; full sharing writes gated, so child/inline mutable convergence statically reviewed only.

## ResourceSharing.ShareResource

All input identity fields and mutable metadata exposed. Fixed account/adopted identity guard, paginated natural lookup and resourceAccountId matching. Child ResourceNotFound includes parent-not-found wire code; no broad catches added. List passed; deployed lifecycle gated by sharing Forbidden.

## ResourceSharing.ShareRecipient

Account/org recipient create fields covered. Fixed unchanged organization recipient replacement comparison by prioritizing old organizationId. Account/scope identity replacement covered. API observation exposes recipient account but no distinct organization field, so organization cold recovery is limited by service response. List passed, create/delete gated by sharing Forbidden.

## Addressing.AddressMap

Compared defaultSni, description, enabled, IPs, memberships; all mutable fields exposed. Added account guard and replacement when managed defaultSni omitted (SDK lacks nullable reset). Existing IP/membership set reconciliation retained. API cannot reliably cold-find map from nonunique description; output UUID required. Actual create/list exercised existing entitlement-aware fixture; nondeletable system maps retained by design.

## Addressing.Prefix

Compared all BYOIP create fields plus description and LOA identity. Added prefix-wide advertised property using get/patch advertisement status, reset previously-managed omission false and withdraw before destroy. LOA explicit add/remove replaces without treating server-generated LOA as desired. Account replacement added. Service-catalog/list reads passed; actual BYOIP ownership/LOA provisioning gated, advertisement addition reviewed only.

## Addressing.BgpPrefix

Compared cidr, advertised, asnPrependCount, onDemandEnabled, onDemandAuto. Added account/adopted identity guards; removed advertisement/prepend/auto settings reset false/0/false. Delete now reads current advertisement before withdrawing instead of trusting stale output. No DELETE API: managed BGP prefix withdrawal is supported teardown. List passed; BYOIP lifecycle gated.

## Addressing.PrefixDelegation

Delegation immutable prefix/delegatedAccount/optionalCIDR fields complete. Added account/observed identity guards for replacement/adoption. Missing parent maps existing DelegationNotFound union code. Read-only list passed; external BYOIP account/delegation fixture gated.

## Addressing.ServiceBinding

Service binding immutable prefix/cidr/serviceId API inputs covered. Added account/observed identity guards; recovery lookup now matches serviceId as well as CIDR. Read-only list passed; owned BYOIP provisioning fixture gated.

## MagicTransit.App

Compared name, type, hostnames, ipSubnets, sourceSubnets, protocol, port. Preserved earlier sourceSubnets addition, added account guard, paginated lookup and array omission reset empty. Typed MagicWanUnauthorized probe/list passed; application lifecycle gated.

## MagicTransit.Site

Compared connector IDs, description, location and name. Added account guard, full paginated name discovery, replacement to reset omitted managed optional fields where API lacks nullable clearing. Typed MagicWanUnauthorized probe/list passed; site graph lifecycle gated.

## MagicTransit.SiteLan

Found missing nested DHCP options and unnecessary required physport. Added exact SDK DHCP options type (type/name/values), optional physport for bonded LANs; observed full static addressing/routed subnets/NAT/bond/prioritization/breakout. Dirty comparison now covers DHCP-only and NAT-only changes with unchanged LAN address. Account/site/HA identity and reset replacement covered; pagination fixed. New real deployed regression fixture checks DHCP domain/NAT update, gated by Magic WAN entitlement; list passed.

## MagicTransit.SiteWan

All writable priority/vlan/static addressing/physport fields compared. Added observed full static addressing and nested dirty comparison, account/site/HA guards, removal reset replacement, paginated lookup. List passed; network lifecycle gated.

## MagicTransit.SiteAcl

Compared description, protocols, forward/unidirectional, lan1/lan2 including lanName/ports/subnets. Added full observed LAN configuration, nested comparison, account/site identity guards, optional reset replacement and pagination. Typed Magic WAN rejection/list passed; actual ACL lifecycle gated.

## MagicTransit.GreTunnel

Found missing BGP import/export filter IDs and dropped initial health direction/rate/type; added full wire fields. Added observed automaticReturnRouting and comparison, health/bgp output shape, account identity guard and omitted-setting replacement. Creation-only BGP updates now delete-first replace to avoid same-name adoption loop. Typed MagicTransitNotOnboarded probe/list passed; real GRE lifecycle gated.

## MagicTransit.IpsecTunnel

Added BGP import/export filter IDs; fixed dirty detection for BGP-only/customer identity/automatic return routing changes. Redacted BGP secret maintained, psk write-only desired comparison. Added observed health/BGP/automatic routing, account guard/reset replacement. Added BGP-only ASN change to actual deployed fixture; gated by MagicTransitNotOnboarded; probe/list passed.

## MagicTransit.StaticRoute

Compared prefix, nexthop, priority, weight, description, scope colo names/regions. Existing nonpaginated route API complete. Added account/identity guards and replacement to clear omitted managed optional configuration. Typed MagicTransitNotOnboarded probe/list passed; route lifecycle gated.

## DdosProtection.AllowlistEntry

All documented prefix identity + scope fields exposed. Added account/observed prefix replacement guard, observe-before-delete retained. List/probe passed; advanced TCP allowlist create gated by entitlement.

## DdosProtection.SynProtectionFilter

Compared name/expression/mode and nested thresholds. Added account guard and natural-expression lookup before create for recovery. Typed entitlement probe/list passed; filter lifecycle gated.

## DdosProtection.TcpFlowProtectionFilter

All documented name/expression/enabled/threshold configuration exposed. Added account guard and natural-expression cold reconcile recovery. List/probe passed; lifecycle gated.

## DdosProtection.SynProtectionRule

All SDK rule nested fields compared. Added account/observed filter/scope/name identity guards; omitted mitigationType now resets documented challenge default. Extended real deployed fixture retransmit→omission reset challenge; gated by advanced TCP entitlement; list passed.

## DdosProtection.TcpFlowProtectionRule

All SDK rule inputs and scope/filter identity exposed. Added account/observed identity replacement guards, retained observed update/delete. List passed; deployed rule lifecycle gated.
