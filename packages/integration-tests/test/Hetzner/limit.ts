import type { Limit } from "@alchemy.run/test";

/**
 * Every Hetzner test that holds primary IPs (Servers, Load Balancers, the
 * Primary IP suite) takes one permit, across all files. The testing project
 * allows 10 primary IPs, IPv4 and IPv6 together: a default Server holds two
 * (one of each), a Load Balancer two, and a create-first replacement briefly
 * holds both generations. Past the quota, creates fail with "Primary IP limit
 * exceeded" (Floating IPs don't count). Tests queue for a permit without it
 * counting against their timeouts.
 *
 * Two holders, one of them at most holding Load Balancers
 * ({@link hetznerLoadBalancers}), peak at 10: a Load Balancer replacement
 * (two Load Balancers and a Server, 6) plus a Server replacement (4).
 */
export const hetznerPrimaryIps: Limit = {
  label: "hetzner-primary-ips",
  permits: Number(process.env.ALCHEMY_TEST_HETZNER_PRIMARY_IP_PERMITS ?? 2),
};

/**
 * Held, one at a time, by tests that create Load Balancers, on top of
 * {@link hetznerPrimaryIps}: each Load Balancer takes two of the project's
 * ten primary IPs.
 */
export const hetznerLoadBalancers = "hetzner-load-balancers";
