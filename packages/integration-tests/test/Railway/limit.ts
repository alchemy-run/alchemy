import type { Limit } from "@alchemy.run/test";

/**
 * Every live Railway test and deploy hook holds one permit, across all files,
 * so the suite never has more than this many cases driving Railway's GraphQL
 * API at once. Past it, Railway answers 429 for long enough that the SDK's
 * bounded retries run out and the deploys fail. Tests queue for a permit
 * without it counting against their timeouts.
 */
export const railwayApi: Limit = {
  label: "railway-api",
  permits: Number(process.env.ALCHEMY_TEST_RAILWAY_PERMITS ?? 4),
};
