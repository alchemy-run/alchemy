import type * as ec2 from "@distilled.cloud/aws/ec2";
import * as IpInterface from "effect/unstable/net/IpInterface";
import * as IpNetwork from "effect/unstable/net/IpNetwork";
import type { IpAddress } from "effect/unstable/net/NetAddress";
import type { SecurityGroupRuleData } from "./SecurityGroup.ts";

type Rule = Omit<Partial<SecurityGroupRuleData>, "referencedGroupId"> & {
  referencedGroupId?: string;
};

const protocols = new Map([
  ["tcp", "6"],
  ["udp", "17"],
  ["icmp", "1"],
  ["icmpv6", "58"],
]);

/**
 * EC2 canonicalizes IPv4 and IPv6 CIDRs by clearing host bits. Effect's native
 * network representation also normalizes IPv6 compression and spelling.
 * https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_IpRange.html
 * https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_Ipv6Range.html
 */
const cidrKey = (cidr: string, family: "ipv4" | "ipv6"): string | undefined => {
  const parsed =
    family === "ipv4"
      ? IpInterface.ipv4FromString(cidr)
      : IpInterface.ipv6FromString(cidr);
  return parsed._tag === "Failure"
    ? undefined
    : IpNetwork.format(IpNetwork.fromInterface<IpAddress>(parsed.success));
};

/** EC2 expands a permission containing several source kinds into separate rules. */
export const expandRules = (
  rules: readonly SecurityGroupRuleData[],
): SecurityGroupRuleData[] =>
  rules.flatMap(
    ({ cidrIpv4, cidrIpv6, referencedGroupId, prefixListId, ...rule }) => {
      const sources = [
        ...(cidrIpv4 === undefined ? [] : [{ cidrIpv4 }]),
        ...(cidrIpv6 === undefined ? [] : [{ cidrIpv6 }]),
        ...(referencedGroupId === undefined ? [] : [{ referencedGroupId }]),
        ...(prefixListId === undefined ? [] : [{ prefixListId }]),
      ];
      return sources.length === 0
        ? [rule]
        : sources.map((source) => ({ ...rule, ...source }));
    },
  );

export const observedRule = (rule: ec2.SecurityGroupRule): Rule => ({
  ipProtocol: rule.IpProtocol,
  fromPort: rule.FromPort,
  toPort: rule.ToPort,
  cidrIpv4: rule.CidrIpv4,
  cidrIpv6: rule.CidrIpv6,
  referencedGroupId: rule.ReferencedGroupInfo?.GroupId,
  prefixListId: rule.PrefixListId,
  description: rule.Description,
});

/** Identity excludes AWS-assigned IDs and mutable descriptions. */
export const ruleKey = (rule: Rule): string | undefined => {
  if (rule.ipProtocol === undefined) return undefined;
  const supplied = protocols.get(rule.ipProtocol) ?? rule.ipProtocol;
  if (!/^(?:-1|\d+)$/.test(supplied) || Number(supplied) > 255)
    return undefined;
  const protocol = String(Number(supplied));
  const ipv4 =
    rule.cidrIpv4 === undefined ? undefined : cidrKey(rule.cidrIpv4, "ipv4");
  const ipv6 =
    rule.cidrIpv6 === undefined ? undefined : cidrKey(rule.cidrIpv6, "ipv6");
  if (
    (rule.cidrIpv4 !== undefined && ipv4 === undefined) ||
    (rule.cidrIpv6 !== undefined && ipv6 === undefined)
  )
    return undefined;
  const sources = [
    ...(rule.cidrIpv4 === undefined ? [] : [["ipv4", ipv4]]),
    ...(rule.cidrIpv6 === undefined ? [] : [["ipv6", ipv6]]),
    ...(rule.referencedGroupId === undefined
      ? []
      : [["group", rule.referencedGroupId]]),
    ...(rule.prefixListId === undefined ? [] : [["prefix", rule.prefixListId]]),
  ];
  if (sources.length !== 1 || !sources[0]?.[1]) return undefined;
  // For protocols other than TCP/UDP/ICMP/ICMPv6 EC2 ignores port ranges.
  // ICMPv6 permits omission of both ports to mean every type and code.
  const hasPorts = ["6", "17", "1", "58"].includes(protocol);
  const fromPort = rule.fromPort ?? (protocol === "58" ? -1 : undefined);
  const toPort = rule.toPort ?? (protocol === "58" ? -1 : undefined);
  if (
    hasPorts &&
    (fromPort === undefined ||
      toPort === undefined ||
      !Number.isInteger(fromPort) ||
      !Number.isInteger(toPort))
  )
    return undefined;
  return JSON.stringify([
    protocol,
    hasPorts ? fromPort : null,
    hasPorts ? toPort : null,
    sources[0],
  ]);
};

export const rulesMatch = (
  desired: readonly SecurityGroupRuleData[],
  observed: readonly ec2.SecurityGroupRule[],
): boolean => {
  const keys = (rules: readonly Rule[]) =>
    rules.map((rule) => {
      const key = ruleKey(rule);
      return key === undefined
        ? undefined
        : JSON.stringify([key, rule.description ?? ""]);
    });
  const expected = keys(expandRules(desired));
  const actual = keys(observed.map(observedRule));
  if (
    expected.includes(undefined) ||
    actual.includes(undefined) ||
    expected.length !== actual.length
  )
    return false;
  expected.sort();
  actual.sort();
  return expected.every((key, index) => key === actual[index]);
};
