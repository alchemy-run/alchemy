import type * as EC2 from "itty-aws/ec2";
import type { Input } from "../../input.ts";
import { Resource } from "../../resource.ts";
import type { AccountID } from "../account.ts";
import type { RegionID } from "../region.ts";
import type { VpcId } from "./vpc.ts";

export const Subnet = Resource<{
  <const ID extends string, const Props extends SubnetProps>(
    id: ID,
    props: Props,
  ): Subnet<ID, Props>;
}>("AWS.EC2.Subnet");

export interface Subnet<
  ID extends string = string,
  Props extends SubnetProps = SubnetProps,
> extends Resource<
    "AWS.EC2.Subnet",
    ID,
    Props,
    SubnetAttrs<Input.Resolve<Props>>,
    Subnet
  > {}

export interface SubnetProps {
  /**
   * The VPC to create the subnet in.
   */
  vpcId: Input<VpcId>;

  /**
   * The IPv4 network range for the subnet, in CIDR notation.
   * Required unless using IPAM.
   * @example "10.0.1.0/24"
   */
  cidrBlock?: string;

  /**
   * The IPv6 network range for the subnet, in CIDR notation.
   */
  ipv6CidrBlock?: string;

  /**
   * The Availability Zone for the subnet.
   * @example "us-east-1a"
   */
  availabilityZone?: string;

  /**
   * The ID of the Availability Zone for the subnet.
   */
  availabilityZoneId?: string;

  /**
   * The ID of an IPv4 IPAM pool you want to use for allocating this subnet's CIDR.
   */
  ipv4IpamPoolId?: string;

  /**
   * The netmask length of the IPv4 CIDR you want to allocate to this subnet from an IPAM pool.
   */
  ipv4NetmaskLength?: number;

  /**
   * The ID of an IPv6 IPAM pool which will be used to allocate this subnet an IPv6 CIDR.
   */
  ipv6IpamPoolId?: Input<string>;

  /**
   * The netmask length of the IPv6 CIDR you want to allocate to this subnet from an IPAM pool.
   */
  ipv6NetmaskLength?: number;

  /**
   * Whether instances launched in the subnet get public IPv4 addresses.
   * @default false
   */
  mapPublicIpOnLaunch?: boolean;

  /**
   * Whether instances launched in the subnet get IPv6 addresses.
   * @default false
   */
  assignIpv6AddressOnCreation?: boolean;

  /**
   * Whether DNS queries made to the Amazon-provided DNS Resolver in this subnet should return
   * synthetic IPv6 addresses for IPv4-only destinations.
   * @default false
   */
  enableDns64?: boolean;

  /**
   * Whether to enable resource name DNS A record on launch.
   * @default false
   */
  enableResourceNameDnsARecordOnLaunch?: boolean;

  /**
   * Whether to enable resource name DNS AAAA record on launch.
   * @default false
   */
  enableResourceNameDnsAAAARecordOnLaunch?: boolean;

  /**
   * The hostname type for EC2 instances launched into this subnet.
   */
  hostnameType?: EC2.HostnameType;

  /**
   * Tags to assign to the subnet.
   * These will be merged with alchemy auto-tags (alchemy::app, alchemy::stage, alchemy::id).
   */
  tags?: Record<string, Input<string>>;
}

export type SubnetId<ID extends string = string> = `subnet-${ID}`;
export const SubnetId = <ID extends string>(id: ID): ID & SubnetId<ID> =>
  `subnet-${id}` as ID & SubnetId<ID>;

export interface SubnetAttrs<Props extends SubnetProps> {
  /**
   * The ID of the VPC the subnet is in.
   */
  vpcId: Props["vpcId"];

  /**
   * The ID of the subnet.
   */
  subnetId: SubnetId;

  /**
   * The Amazon Resource Name (ARN) of the subnet.
   */
  subnetArn: `arn:aws:ec2:${RegionID}:${AccountID}:subnet/${this["subnetId"]}`;

  /**
   * The IPv4 CIDR block for the subnet.
   */
  cidrBlock: string;

  /**
   * The Availability Zone of the subnet.
   */
  availabilityZone: string;

  /**
   * The ID of the Availability Zone of the subnet.
   */
  availabilityZoneId?: string;

  /**
   * The current state of the subnet.
   */
  state: EC2.SubnetState;

  /**
   * The number of available IPv4 addresses in the subnet.
   */
  availableIpAddressCount: number;

  /**
   * Whether instances launched in the subnet get public IPv4 addresses.
   */
  mapPublicIpOnLaunch: boolean;

  /**
   * Whether instances launched in the subnet get IPv6 addresses.
   */
  assignIpv6AddressOnCreation: Props["assignIpv6AddressOnCreation"];

  /**
   * Whether the subnet is the default subnet for the Availability Zone.
   */
  defaultForAz: boolean;

  /**
   * The ID of the AWS account that owns the subnet.
   */
  ownerId?: string;

  /**
   * Information about the IPv6 CIDR blocks associated with the subnet.
   */
  ipv6CidrBlockAssociationSet?: Array<{
    associationId: string;
    ipv6CidrBlock: string;
    ipv6CidrBlockState: {
      state: EC2.SubnetCidrBlockStateCode;
      statusMessage?: string;
    };
  }>;

  /**
   * Whether DNS64 is enabled for the subnet.
   */
  enableDns64?: boolean;

  /**
   * Whether this is an IPv6-only subnet.
   */
  ipv6Native?: boolean;

  /**
   * The private DNS name options on launch.
   */
  privateDnsNameOptionsOnLaunch?: {
    hostnameType?: EC2.HostnameType;
    enableResourceNameDnsARecord?: boolean;
    enableResourceNameDnsAAAARecord?: boolean;
  };
}
