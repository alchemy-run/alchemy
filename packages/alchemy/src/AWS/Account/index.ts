// AWS Account Management (sdkId: "account") — control-plane-only service.
//
// Action -> coverage ledger:
// - putAccountName / getAccountInformation      -> AccountName resource
// - putContactInformation / getContactInformation -> ContactInformation resource
// - put/get/deleteAlternateContact              -> AlternateContact resource
// - enableRegion / disableRegion / getRegionOptStatus / listRegions -> Region resource
// - startPrimaryEmailUpdate / acceptPrimaryEmailUpdate / getPrimaryEmail
//     Out of scope: the primary (root) email update flow requires a
//     one-time password delivered to the new mailbox — a human-in-the-loop
//     workflow that cannot be automated as a resource or runtime binding.
// - getGovCloudAccountInformation
//     Out of scope: management read of the linked GovCloud account; no
//     plausible runtime/consumer use.
//
// No runtime bindings or event sources: every Account action is account
// management (root-level account settings) with no data plane a deployed
// Function/Worker would call, and the service emits no event streams or
// notification configurations.
export * from "./AccountName.ts";
export * from "./AlternateContact.ts";
export * from "./ContactInformation.ts";
export * from "./Region.ts";
