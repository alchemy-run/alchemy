import * as Vercel from "@/Vercel/index.ts";

/** Cycle-1 declarative item set. */
export const CHAIN_ITEMS_V1 = {
  greeting: "chain-v1",
  rollout: 10,
};

/** Cycle-2+ item set: one changed value, one added key, one removed key. */
export const CHAIN_ITEMS_V2 = {
  greeting: "chain-v2",
  featureX: true,
};

/**
 * The chain's Edge Config. Like {@link ChainStore}, the test's deploy
 * programs re-register the same logical id with the cycle's item set BEFORE
 * yielding the Function fixture, so the fixture's internal yield resolves
 * to the cycle's declaration (first-registration-wins).
 */
export const ChainFlags = Vercel.EdgeConfig("ChainFlags", {
  items: { ...CHAIN_ITEMS_V1 },
});
