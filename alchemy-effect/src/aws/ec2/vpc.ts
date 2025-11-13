import type * as EC2 from "itty-aws/ec2";
import { Resource } from "../../resource.ts";
import type { AccountID } from "../account.ts";
import type { RegionID } from "../region.ts";

export const Vpc = Resource<{
  <const ID extends string, const Props extends VpcProps>(
    id: ID,
    props: Props,
  ): Vpc<ID, Props>;
}>("AWS.EC2.VPC");

export interface Vpc<
  ID extends string = string,
  Props extends VpcProps = VpcProps,
> extends Resource<"AWS.EC2.VPC", ID, Props, VpcAttrs<Props>> {}

export interface VpcProps {
  /**
   * The IPv4 network range for the VPC, in CIDR notation.
   * Required unless using IPAM.
   * @example "10.0.0.0/16"
   */
  cidrBlock?: string;

  /**
   * The ID of an IPv4 IPAM pool you want to use for allocating this VPC's CIDR.
   */
  ipv4IpamPoolId?: string;

  /**
   * The netmask length of the IPv4 CIDR you want to allocate to this VPC from an IPAM pool.
   */
  ipv4NetmaskLength?: number;

  /**
   * The ID of an IPv6 IPAM pool which will be used to allocate this VPC an IPv6 CIDR.
   */
  ipv6IpamPoolId?: string;

  /**
   * The netmask length of the IPv6 CIDR you want to allocate to this VPC from an IPAM pool.
   */
  ipv6NetmaskLength?: number;

  /**
   * Requests an Amazon-provided IPv6 CIDR block with a /56 prefix length for the VPC.
   */
  ipv6CidrBlock?: string;

  /**
   * The ID of an IPv6 address pool from which to allocate the IPv6 CIDR block.
   */
  ipv6Pool?: string;

  /**
   * The Availability Zone or Local Zone Group name for the IPv6 CIDR block.
   */
  ipv6CidrBlockNetworkBorderGroup?: string;

  /**
   * The tenancy options for instances launched into the VPC.
   * @default "default"
   */
  instanceTenancy?: EC2.Tenancy;

  /**
   * Whether DNS resolution is supported for the VPC.
   * @default true
   */
  enableDnsSupport?: boolean;

  /**
   * Whether instances launched in the VPC get DNS hostnames.
   * @default true
   */
  enableDnsHostnames?: boolean;

  /**
   * Requests an Amazon-provided IPv6 CIDR block with a /56 prefix length for the VPC.
   */
  amazonProvidedIpv6CidrBlock?: boolean;

  /**
   * Tags to assign to the VPC.
   * These will be merged with alchemy auto-tags (alchemy::app, alchemy::stage, alchemy::id).
   */
  tags?: Record<string, string>;
}

export interface VpcAttrs<Props extends VpcProps> {
  /**
   * The ID of the VPC.
   */
  vpcId: string;

  /**
   * The Amazon Resource Name (ARN) of the VPC.
   */
  vpcArn: `arn:aws:ec2:${RegionID}:${AccountID}:vpc/${this["vpcId"]}`;

  /**
   * The primary IPv4 CIDR block for the VPC.
   */
  cidrBlock: string;

  /**
   * The ID of the set of DHCP options associated with the VPC.
   */
  dhcpOptionsId: string;

  /**
   * The current state of the VPC.
   */
  state: EC2.VpcState;

  /**
   * Whether the VPC is the default VPC.
   */
  isDefault: boolean;

  /**
   * The ID of the AWS account that owns the VPC.
   */
  ownerId?: string;

  /**
   * Information about the IPv4 CIDR blocks associated with the VPC.
   */
  cidrBlockAssociationSet?: Array<{
    associationId: string;
    cidrBlock: string;
    cidrBlockState: {
      state: EC2.VpcCidrBlockStateCode;
      statusMessage?: string;
    };
  }>;

  /**
   * Information about the IPv6 CIDR blocks associated with the VPC.
   */
  ipv6CidrBlockAssociationSet?: Array<{
    associationId: string;
    ipv6CidrBlock: string;
    ipv6CidrBlockState: {
      state: EC2.VpcCidrBlockStateCode;
      statusMessage?: string;
    };
    networkBorderGroup?: string;
    ipv6Pool?: string;
  }>;
}
