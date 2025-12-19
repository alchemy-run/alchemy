import type * as EC2 from "itty-aws/ec2";
import type { Input } from "../../input.ts";
import { Resource } from "../../resource.ts";
import type { NetworkAclId } from "./network-acl.ts";

export const NetworkAclEntry = Resource<{
  <const ID extends string, const Props extends NetworkAclEntryProps>(
    id: ID,
    props: Props,
  ): NetworkAclEntry<ID, Props>;
}>("AWS.EC2.NetworkAclEntry");

export interface NetworkAclEntry<
  ID extends string = string,
  Props extends NetworkAclEntryProps = NetworkAclEntryProps,
> extends Resource<
  "AWS.EC2.NetworkAclEntry",
  ID,
  Props,
  NetworkAclEntryAttrs<Input.Resolve<Props>>,
  NetworkAclEntry
> {}

export interface NetworkAclEntryProps {
  /**
   * The ID of the network ACL.
   */
  networkAclId: Input<NetworkAclId>;

  /**
   * The rule number for the entry (1-32766).
   * Rules are evaluated in order from lowest to highest.
   */
  ruleNumber: number;

  /**
   * The protocol number.
   * A value of "-1" means all protocols.
   * Common values: 6 (TCP), 17 (UDP), 1 (ICMP)
   */
  protocol: string;

  /**
   * Whether to allow or deny the traffic that matches the rule.
   */
  ruleAction: EC2.RuleAction;

  /**
   * Whether this is an egress (outbound) rule.
   * @default false (ingress)
   */
  egress?: boolean;

  /**
   * The IPv4 CIDR block.
   * Either cidrBlock or ipv6CidrBlock must be specified.
   */
  cidrBlock?: string;

  /**
   * The IPv6 CIDR block.
   * Either cidrBlock or ipv6CidrBlock must be specified.
   */
  ipv6CidrBlock?: string;

  /**
   * ICMP type and code. Required if protocol is 1 (ICMP) or 58 (ICMPv6).
   */
  icmpTypeCode?: {
    /**
     * The ICMP code. Use -1 to specify all codes.
     */
    code?: number;
    /**
     * The ICMP type. Use -1 to specify all types.
     */
    type?: number;
  };

  /**
   * The port range for TCP/UDP protocols.
   */
  portRange?: {
    /**
     * The first port in the range.
     */
    from?: number;
    /**
     * The last port in the range.
     */
    to?: number;
  };
}

export interface NetworkAclEntryAttrs<Props extends NetworkAclEntryProps> {
  /**
   * The ID of the network ACL.
   */
  networkAclId: Props["networkAclId"];

  /**
   * The rule number.
   */
  ruleNumber: Props["ruleNumber"];

  /**
   * Whether this is an egress rule.
   */
  egress: boolean;

  /**
   * The protocol.
   */
  protocol: Props["protocol"];

  /**
   * The rule action (allow or deny).
   */
  ruleAction: Props["ruleAction"];

  /**
   * The IPv4 CIDR block.
   */
  cidrBlock?: Props["cidrBlock"];

  /**
   * The IPv6 CIDR block.
   */
  ipv6CidrBlock?: Props["ipv6CidrBlock"];

  /**
   * The ICMP type and code.
   */
  icmpTypeCode?: Props["icmpTypeCode"];

  /**
   * The port range.
   */
  portRange?: Props["portRange"];
}
