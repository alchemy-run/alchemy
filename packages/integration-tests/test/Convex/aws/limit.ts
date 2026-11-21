import type { Limit } from "@alchemy.run/test";

/**
 * Every self-hosted suite that creates a network takes one permit, across all
 * files. Each network's NAT gateway holds an Elastic IP, and the testing
 * account's region allows five, shared with every other AWS suite. Past it,
 * the NAT gateway fails with `AddressLimitExceeded`. Tests queue for a permit
 * without it counting against their timeouts.
 */
export const convexNetworks: Limit = {
  label: "aws-convex-networks",
  permits: Number(process.env.ALCHEMY_TEST_CONVEX_NETWORK_PERMITS ?? 2),
};
