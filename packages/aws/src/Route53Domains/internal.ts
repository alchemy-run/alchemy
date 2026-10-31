import { withGlobalRegion } from "../Region.ts";

// The Route 53 Domains API is global and only served from us-east-1,
// regardless of where the calling function runs. Pin every call to the
// partition's global region (us-east-1 in `aws`) so a Lambda deployed in any
// region resolves a valid endpoint.
export const withRoute53DomainsRegion = withGlobalRegion;
