import { withGlobalRegion } from "../Region.ts";

// The AWS Price List Query API is only served from a few regions, regardless
// of where the calling function runs. Pin every pricing call to the
// partition's global region (us-east-1 in `aws`) so a Lambda deployed in any
// region resolves a valid endpoint.
export const withPricingRegion = withGlobalRegion;
