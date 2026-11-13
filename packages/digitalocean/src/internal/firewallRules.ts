import * as Arr from "effect/Array";
import type { FirewallRule, FirewallRulePorts, FirewallRuleProtocol } from "../Firewall.ts";
import { setEquals } from "./equal.ts";

// Canonical numeric form, so `"022"` and `"22"` compare equal.
const parsePorts = (ports: string): FirewallRulePorts => {
  const [from, to] = ports.split("-").map(Number);
  return to === undefined ? `${from}` : `${from}-${to}`;
};

export const normalizePorts = (rule: {
  readonly protocol: FirewallRuleProtocol;
  readonly ports: string;
}): FirewallRulePorts => (rule.protocol === "icmp" ? "0" : parsePorts(rule.ports));

const memberList = (members: ReadonlyArray<string | number> | undefined) =>
  Arr.dedupe((members ?? []).map(String))
    .sort()
    .join(",");

// IPv6 addresses compare case-insensitively.
const addressList = (addresses: ReadonlyArray<string> | undefined) =>
  memberList(addresses?.map((address) => address.toLowerCase()));

const fingerprintRule = (rule: FirewallRule) =>
  [
    rule.protocol,
    normalizePorts(rule),
    rule.action ?? "allow",
    addressList(rule.addresses),
    memberList(rule.dropletIds),
    memberList(rule.loadBalancerUids),
    memberList(rule.kubernetesIds),
    memberList(rule.tags),
  ].join("|");

/**
 * True when both lists filter the same traffic. Rule order, member order
 * and repeats do not matter.
 */
export const haveSameRules = (
  a: ReadonlyArray<FirewallRule> | undefined,
  b: ReadonlyArray<FirewallRule> | undefined,
) => setEquals(a?.map(fingerprintRule), b?.map(fingerprintRule));

export const uniqueRules = (rules: ReadonlyArray<FirewallRule>): FirewallRule[] => [
  ...new Map(rules.map((rule) => [fingerprintRule(rule), rule] as const)).values(),
];
