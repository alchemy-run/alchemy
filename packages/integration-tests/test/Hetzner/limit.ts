import type { Limit } from "@alchemy.run/test";

/**
 * Every Hetzner test that holds public IPv4 addresses (Servers, Load
 * Balancers, the Primary IP suite) takes one permit, across all files. The
 * testing project allows 10: a Server holds one, a Load Balancer two, and a
 * create-first replacement briefly holds both generations. Past the quota,
 * creates fail with "Primary IP limit exceeded" (Floating IPs don't count).
 * Tests queue for a permit without it counting against their timeouts.
 *
 * Three holders, one of them at most holding Load Balancers
 * ({@link hetznerLoadBalancers}), peak at 9: a Load Balancer replacement
 * (two Load Balancers and a Server, 5) plus two Server replacements (2 each).
 */
export const hetznerPrimaryIps: Limit = {
  label: "hetzner-primary-ips",
  permits: Number(process.env.ALCHEMY_TEST_HETZNER_PRIMARY_IP_PERMITS ?? 3),
};

/**
 * Held, one at a time, by tests that create Load Balancers, on top of
 * {@link hetznerPrimaryIps}: each Load Balancer takes two of the project's
 * ten IPv4 addresses.
 */
export const hetznerLoadBalancers = "hetzner-load-balancers";
