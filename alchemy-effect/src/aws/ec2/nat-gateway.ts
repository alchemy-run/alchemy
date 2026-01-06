import type * as EC2 from "distilled-aws/ec2";
import type { Input } from "../../input.ts";
import { Resource } from "../../resource.ts";
import type { AccountID } from "../account.ts";
import type { RegionID } from "../region.ts";
import type { AllocationId } from "./eip.ts";
import type { SubnetId } from "./subnet.ts";

export const NatGateway = Resource<{
  <const ID extends string, const Props extends NatGatewayProps>(
    id: ID,
    props: Props,
  ): NatGateway<ID, Props>;
}>("AWS.EC2.NatGateway");

export interface NatGateway<
  ID extends string = string,
  Props extends NatGatewayProps = NatGatewayProps,
> extends Resource<
  "AWS.EC2.NatGateway",
  ID,
  Props,
  NatGatewayAttrs<Input.Resolve<Props>>,
  NatGateway
> {}

export type NatGatewayId<ID extends string = string> = `nat-${ID}`;
export const NatGatewayId = <ID extends string>(
  id: ID,
): ID & NatGatewayId<ID> => `nat-${id}` as ID & NatGatewayId<ID>;

export interface NatGatewayProps {
  /**
   * The subnet in which to create the NAT gateway.
   * For public NAT gateways, this must be a public subnet.
   */
  subnetId: Input<SubnetId>;

  /**
   * The allocation ID of the Elastic IP address for the gateway.
   * Required for public NAT gateways.
   */
  allocationId?: Input<AllocationId>;

  /**
   * Indicates whether the NAT gateway supports public or private connectivity.
   * @default "public"
   */
  connectivityType?: EC2.ConnectivityType;

  /**
   * The private IPv4 address to assign to the NAT gateway.
   * If you don't provide an address, a private IPv4 address will be automatically assigned.
   */
  privateIpAddress?: string;

  /**
   * Secondary allocation IDs for additional private IP addresses.
   * Only valid for private NAT gateways.
   */
  secondaryAllocationIds?: Input<AllocationId>[];

  /**
   * Secondary private IPv4 addresses.
   * Only valid for private NAT gateways.
   */
  secondaryPrivateIpAddresses?: string[];

  /**
   * The number of secondary private IPv4 addresses to assign.
   * Only valid for private NAT gateways.
   */
  secondaryPrivateIpAddressCount?: number;

  /**
   * Tags to assign to the NAT gateway.
   */
  tags?: Record<string, Input<string>>;
}

export interface NatGatewayAttrs<Props extends NatGatewayProps> {
  /**
   * The ID of the NAT gateway.
   */
  natGatewayId: NatGatewayId;

  /**
   * The Amazon Resource Name (ARN) of the NAT gateway.
   */
  natGatewayArn: `arn:aws:ec2:${RegionID}:${AccountID}:natgateway/${this["natGatewayId"]}`;

  /**
   * The ID of the subnet in which the NAT gateway is located.
   */
  subnetId: Props["subnetId"];

  /**
   * The ID of the VPC in which the NAT gateway is located.
   */
  vpcId: string;

  /**
   * The current state of the NAT gateway.
   */
  state: EC2.NatGatewayState;

  /**
   * The connectivity type of the NAT gateway.
   */
  connectivityType: EC2.ConnectivityType;

  /**
   * The Elastic IP address associated with the NAT gateway (for public NAT gateways).
   */
  publicIp?: string;

  /**
   * The private IP address associated with the NAT gateway.
   */
  privateIp?: string;

  /**
   * Information about the IP addresses and network interface associated with the NAT gateway.
   */
  natGatewayAddresses?: Array<{
    allocationId?: string;
    networkInterfaceId?: string;
    privateIp?: string;
    publicIp?: string;
    associationId?: string;
    isPrimary?: boolean;
    failureMessage?: string;
    status?: EC2.NatGatewayAddressStatus;
  }>;

  /**
   * If the NAT gateway could not be created, specifies the error code for the failure.
   */
  failureCode?: string;

  /**
   * If the NAT gateway could not be created, specifies the error message for the failure.
   */
  failureMessage?: string;

  /**
   * The date and time the NAT gateway was created.
   */
  createTime?: string;

  /**
   * The date and time the NAT gateway was deleted, if applicable.
   */
  deleteTime?: string;
}
