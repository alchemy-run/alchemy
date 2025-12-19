import type * as EC2 from "itty-aws/ec2";
import type { Input } from "../../input.ts";
import { Resource } from "../../resource.ts";
import type { AccountID } from "../account.ts";
import type { RegionID } from "../region.ts";
import type { VpcId } from "./vpc.ts";

export const NetworkAcl = Resource<{
  <const ID extends string, const Props extends NetworkAclProps>(
    id: ID,
    props: Props,
  ): NetworkAcl<ID, Props>;
}>("AWS.EC2.NetworkAcl");

export interface NetworkAcl<
  ID extends string = string,
  Props extends NetworkAclProps = NetworkAclProps,
> extends Resource<
  "AWS.EC2.NetworkAcl",
  ID,
  Props,
  NetworkAclAttrs<Input.Resolve<Props>>,
  NetworkAcl
> {}

export type NetworkAclId<ID extends string = string> = `acl-${ID}`;
export const NetworkAclId = <ID extends string>(
  id: ID,
): ID & NetworkAclId<ID> => `acl-${id}` as ID & NetworkAclId<ID>;

export interface NetworkAclProps {
  /**
   * The VPC to create the network ACL in.
   */
  vpcId: Input<VpcId>;

  /**
   * Tags to assign to the network ACL.
   */
  tags?: Record<string, Input<string>>;
}

export type NetworkAclArn<ID extends NetworkAclId = NetworkAclId> =
  `arn:aws:ec2:${RegionID}:${AccountID}:network-acl/${ID}`;

export interface NetworkAclAttrs<
  Props extends Input.Resolve<NetworkAclProps> = Input.Resolve<NetworkAclProps>,
> {
  /**
   * The ID of the network ACL.
   */
  networkAclId: NetworkAclId;

  /**
   * The Amazon Resource Name (ARN) of the network ACL.
   */
  networkAclArn: NetworkAclArn<this["networkAclId"]>;

  /**
   * The ID of the VPC for the network ACL.
   */
  vpcId: Props["vpcId"];

  /**
   * Whether this is the default network ACL for the VPC.
   */
  isDefault: boolean;

  /**
   * The ID of the AWS account that owns the network ACL.
   */
  ownerId: string;

  /**
   * The entries (rules) in the network ACL.
   */
  entries?: Array<{
    ruleNumber: number;
    protocol: string;
    ruleAction: EC2.RuleAction;
    egress: boolean;
    cidrBlock?: string;
    ipv6CidrBlock?: string;
    icmpTypeCode?: {
      code?: number;
      type?: number;
    };
    portRange?: {
      from?: number;
      to?: number;
    };
  }>;

  /**
   * The associations between the network ACL and subnets.
   */
  associations?: Array<{
    networkAclAssociationId: string;
    networkAclId: string;
    subnetId: string;
  }>;
}
