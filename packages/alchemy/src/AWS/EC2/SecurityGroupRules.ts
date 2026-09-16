import type * as ec2 from "@distilled.cloud/aws/ec2";
import type {
  SecurityGroupId,
  SecurityGroupRuleData,
} from "./SecurityGroup.ts";

export const canonicalSecurityGroupCidr = (cidr: string | undefined) => {
  if (cidr === undefined) return undefined;
  const [address, prefixText, extra] = cidr.split("/");
  if (!address || prefixText === undefined || extra !== undefined) return cidr;
  const ipv6 = address.includes(":");
  const bits = ipv6 ? 128 : 32;
  const prefix = Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) return cidr;
  let value = 0n;
  if (ipv6) {
    const halves = address.split("::");
    if (halves.length > 2) return cidr;
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves[1] ? halves[1].split(":") : [];
    const words =
      halves.length === 2
        ? [
            ...left,
            ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"),
            ...right,
          ]
        : left;
    if (
      words.length !== 8 ||
      words.some((word) => !/^[0-9a-f]{1,4}$/i.test(word))
    )
      return cidr;
    for (const word of words)
      value = (value << 16n) | BigInt(parseInt(word, 16));
  } else {
    const octets = address.split(".");
    if (
      octets.length !== 4 ||
      octets.some((octet) => !/^\d{1,3}$/.test(octet) || Number(octet) > 255)
    )
      return cidr;
    for (const octet of octets) value = (value << 8n) | BigInt(octet);
  }
  const shift = BigInt(bits - prefix);
  const network = (value >> shift) << shift;
  if (!ipv6) {
    return `${[24, 16, 8, 0].map((offset) => Number((network >> BigInt(offset)) & 255n)).join(".")}/${prefix}`;
  }
  const words = Array.from({ length: 8 }, (_, index) =>
    ((network >> BigInt((7 - index) * 16)) & 0xffffn).toString(16),
  );
  let start = -1;
  let length = 1;
  for (let index = 0; index < words.length; index++) {
    if (words[index] !== "0") continue;
    let end = index + 1;
    while (end < words.length && words[end] === "0") end++;
    if (end - index > length) {
      start = index;
      length = end - index;
    }
    index = end - 1;
  }
  const addressKey =
    start < 0
      ? words.join(":")
      : `${words.slice(0, start).join(":")}::${words.slice(start + length).join(":")}`;
  return `${addressKey}/${prefix}`;
};

const protocols: Record<string, string> = {
  "6": "tcp",
  "17": "udp",
  "1": "icmp",
  "58": "icmpv6",
};

export const securityGroupRuleKey = (rule: SecurityGroupRuleData) => {
  const protocol = protocols[rule.ipProtocol] ?? rule.ipProtocol;
  const hasPorts = ["tcp", "udp", "icmp", "icmpv6"].includes(protocol);
  return JSON.stringify({
    protocol,
    from: hasPorts
      ? (rule.fromPort ?? (protocol === "icmpv6" ? -1 : undefined))
      : undefined,
    to: hasPorts
      ? (rule.toPort ?? (protocol === "icmpv6" ? -1 : undefined))
      : undefined,
    ipv4: canonicalSecurityGroupCidr(rule.cidrIpv4),
    ipv6: canonicalSecurityGroupCidr(rule.cidrIpv6),
    group: rule.referencedGroupId,
    prefix: rule.prefixListId,
    description: rule.description ?? "",
  });
};

export const observedSecurityGroupRuleKey = (rule: ec2.SecurityGroupRule) =>
  securityGroupRuleKey({
    ipProtocol: rule.IpProtocol!,
    fromPort: rule.FromPort,
    toPort: rule.ToPort,
    cidrIpv4: rule.CidrIpv4,
    cidrIpv6: rule.CidrIpv6,
    referencedGroupId: rule.ReferencedGroupInfo?.GroupId as
      | SecurityGroupId
      | undefined,
    prefixListId: rule.PrefixListId,
    description: rule.Description,
  });

// EC2 creates one physical rule per source in an IpPermission.
export const expandSecurityGroupRules = (rules: SecurityGroupRuleData[]) =>
  rules.flatMap(
    ({ cidrIpv4, cidrIpv6, referencedGroupId, prefixListId, ...rule }) => [
      ...(cidrIpv4 === undefined ? [] : [{ ...rule, cidrIpv4 }]),
      ...(cidrIpv6 === undefined ? [] : [{ ...rule, cidrIpv6 }]),
      ...(referencedGroupId === undefined
        ? []
        : [{ ...rule, referencedGroupId }]),
      ...(prefixListId === undefined ? [] : [{ ...rule, prefixListId }]),
    ],
  );
