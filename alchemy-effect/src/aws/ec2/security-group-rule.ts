import type { Input } from "../../input.ts";
import { Resource } from "../../resource.ts";
import type { SecurityGroupId } from "./security-group.ts";

export const SecurityGroupRule = Resource<{
  <const ID extends string, const Props extends SecurityGroupRuleProps>(
    id: ID,
    props: Props,
  ): SecurityGroupRule<ID, Props>;
}>("AWS.EC2.SecurityGroupRule");

export interface SecurityGroupRule<
  ID extends string = string,
  Props extends SecurityGroupRuleProps = SecurityGroupRuleProps,
> extends Resource<
  "AWS.EC2.SecurityGroupRule",
  ID,
  Props,
  SecurityGroupRuleAttrs<Input.Resolve<Props>>,
  SecurityGroupRule
> {}

export type SecurityGroupRuleId<ID extends string = string> = `sgr-${ID}`;
export const SecurityGroupRuleId = <ID extends string>(
  id: ID,
): ID & SecurityGroupRuleId<ID> => `sgr-${id}` as ID & SecurityGroupRuleId<ID>;

export interface SecurityGroupRuleProps {
  /**
   * The ID of the security group.
   */
  groupId: Input<SecurityGroupId>;

  /**
   * Whether this is an ingress (inbound) or egress (outbound) rule.
   */
  type: "ingress" | "egress";

  /**
   * The IP protocol name or number.
   * Use -1 to specify all protocols.
   */
  ipProtocol: string;

  /**
   * The start of the port range.
   * For ICMP, use the ICMP type number.
   */
  fromPort?: number;

  /**
   * The end of the port range.
   * For ICMP, use the ICMP code.
   */
  toPort?: number;

  /**
   * IPv4 CIDR range to allow.
   */
  cidrIpv4?: string;

  /**
   * IPv6 CIDR range to allow.
   */
  cidrIpv6?: string;

  /**
   * ID of a security group to allow traffic from/to.
   */
  referencedGroupId?: Input<SecurityGroupId>;

  /**
   * ID of a prefix list.
   */
  prefixListId?: Input<string>;

  /**
   * Description for the rule.
   */
  description?: string;

  /**
   * Tags to assign to the security group rule.
   */
  tags?: Record<string, Input<string>>;
}

export interface SecurityGroupRuleAttrs<
  Props extends Input.Resolve<SecurityGroupRuleProps> =
    Input.Resolve<SecurityGroupRuleProps>,
> {
  /**
   * The ID of the security group rule.
   */
  securityGroupRuleId: SecurityGroupRuleId;

  /**
   * The ID of the security group.
   */
  groupId: Props["groupId"];

  /**
   * The ID of the AWS account that owns the security group.
   */
  groupOwnerId: string;

  /**
   * Whether this is an egress rule.
   */
  isEgress: Props["type"] extends "egress" ? true : false;

  /**
   * The IP protocol.
   */
  ipProtocol: Props["ipProtocol"];

  /**
   * The start of the port range.
   */
  fromPort?: number;

  /**
   * The end of the port range.
   */
  toPort?: number;

  /**
   * The IPv4 CIDR range.
   */
  cidrIpv4?: Props["cidrIpv4"];

  /**
   * The IPv6 CIDR range.
   */
  cidrIpv6?: Props["cidrIpv6"];

  /**
   * The ID of the referenced security group.
   */
  referencedGroupId?: string;

  /**
   * The ID of the prefix list.
   */
  prefixListId?: string;

  /**
   * The description.
   */
  description?: Props["description"];
}
