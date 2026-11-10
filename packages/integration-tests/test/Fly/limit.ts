import type { Limit } from "@alchemy.run/test";

/**
 * Every live Fly test and deploy hook holds one permit, across all files, so
 * the suite never has more than this many cases driving Fly's Machines API.
 * Past it, Fly answers with 429s and slows App deletes and Machine starts
 * enough to miss the readiness and drain windows the tests measure. Tests
 * queue for a permit without it counting against their timeouts.
 */
export const flyApi: Limit = {
  label: "fly-api",
  permits: Number(process.env.ALCHEMY_TEST_FLY_PERMITS ?? 12),
};
