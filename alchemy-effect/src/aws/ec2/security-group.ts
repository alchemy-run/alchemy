import type { Input } from "../../input.ts";
import { Resource } from "../../resource.ts";
import type { AccountID } from "../account.ts";
import type { RegionID } from "../region.ts";
import type { VpcId } from "./vpc.ts";

export const SecurityGroup = Resource<{
  <const ID extends string, const Props extends SecurityGroupProps>(
    id: ID,
    props: Props,
  ): SecurityGroup<ID, Props>;
}>("AWS.EC2.SecurityGroup");

export interface SecurityGroup<
  ID extends string = string,
  Props extends SecurityGroupProps = SecurityGroupProps,
> extends Resource<
  "AWS.EC2.SecurityGroup",
  ID,
  Props,
  SecurityGroupAttrs<Input.Resolve<Props>>,
  SecurityGroup
> {}

export type SecurityGroupId<ID extends string = string> = `sg-${ID}`;
export const SecurityGroupId = <ID extends string>(
  id: ID,
): ID & SecurityGroupId<ID> => `sg-${id}` as ID & SecurityGroupId<ID>;

export type SecurityGroupArn<
  GroupId extends SecurityGroupId = SecurityGroupId,
> = `arn:aws:ec2:${RegionID}:${AccountID}:security-group/${GroupId}`;

/**
 * Ingress or egress rule for a security group.
 */
export interface SecurityGroupRuleData {
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
   * IPv4 CIDR ranges to allow.
   */
  cidrIpv4?: string;

  /**
   * IPv6 CIDR ranges to allow.
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
}

export interface SecurityGroupProps {
  /**
   * The VPC to create the security group in.
   */
  vpcId: Input<VpcId>;

  /**
   * The name of the security group.
   * If not provided, a name will be generated.
   */
  groupName?: string;

  /**
   * A description for the security group.
   * @default "Managed by Alchemy"
   */
  description?: string;

  /**
   * Inbound rules for the security group.
   */
  ingress?: SecurityGroupRuleData[];

  /**
   * Outbound rules for the security group.
   * If not specified, allows all outbound traffic by default.
   */
  egress?: SecurityGroupRuleData[];

  /**
   * Tags to assign to the security group.
   */
  tags?: Record<string, Input<string>>;
}

export interface SecurityGroupAttrs<
  Props extends Input.Resolve<SecurityGroupProps> =
    Input.Resolve<SecurityGroupProps>,
> {
  /**
   * The ID of the security group.
   */
  groupId: SecurityGroupId;

  /**
   * The Amazon Resource Name (ARN) of the security group.
   */
  groupArn: SecurityGroupArn<this["groupId"]>;

  /**
   * The name of the security group.
   */
  groupName: string;

  /**
   * The description of the security group.
   */
  description: string;

  /**
   * The ID of the VPC for the security group.
   */
  vpcId: Props["vpcId"];

  /**
   * The ID of the AWS account that owns the security group.
   */
  ownerId: string;

  /**
   * The inbound rules associated with the security group.
   */
  ingressRules?: Array<{
    securityGroupRuleId: string;
    ipProtocol: string;
    fromPort?: number;
    toPort?: number;
    cidrIpv4?: string;
    cidrIpv6?: string;
    referencedGroupId?: string;
    prefixListId?: string;
    description?: string;
    isEgress: false;
  }>;

  /**
   * The outbound rules associated with the security group.
   */
  egressRules?: Array<{
    securityGroupRuleId: string;
    ipProtocol: string;
    fromPort?: number;
    toPort?: number;
    cidrIpv4?: string;
    cidrIpv6?: string;
    referencedGroupId?: string;
    prefixListId?: string;
    description?: string;
    isEgress: true;
  }>;
}
