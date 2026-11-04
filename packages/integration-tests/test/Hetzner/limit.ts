import type { Limit } from "@alchemy.run/test";

/**
 * Every Hetzner test that holds Primary IPs (Servers, Load Balancers, the
 * Primary IP suite) takes one permit, across all files. The testing project
 * allows 10 IPv4 and 10 IPv6 Primary IPs; a Server holds one of each, and a
 * create-first replacement briefly holds two. Past the quota, creates fail
 * with "Primary IP limit exceeded". Four holders stay under it even while
 * each is mid-replacement. Tests queue for a permit without it counting
 * against their timeouts.
 */
export const hetznerPrimaryIps: Limit = {
  label: "hetzner-primary-ips",
  permits: Number(process.env.ALCHEMY_TEST_HETZNER_PRIMARY_IP_PERMITS ?? 4),
};
