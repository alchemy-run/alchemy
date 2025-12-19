import type { Input } from "../../input.ts";
import { Resource } from "../../resource.ts";
import type { AccountID } from "../account.ts";
import type { RegionID } from "../region.ts";

export const Eip = Resource<{
  <const ID extends string, const Props extends EipProps>(
    id: ID,
    props: Props,
  ): Eip<ID, Props>;
}>("AWS.EC2.EIP");

export interface Eip<
  ID extends string = string,
  Props extends EipProps = EipProps,
> extends Resource<
  "AWS.EC2.EIP",
  ID,
  Props,
  EipAttrs<Input.Resolve<Props>>,
  Eip
> {}

export type AllocationId<ID extends string = string> = `eipalloc-${ID}`;
export const AllocationId = <ID extends string>(
  id: ID,
): ID & AllocationId<ID> => `eipalloc-${id}` as ID & AllocationId<ID>;

export interface EipProps {
  /**
   * Indicates whether the Elastic IP address is for use with instances in a VPC or EC2-Classic.
   * @default "vpc"
   */
  domain?: "vpc" | "standard";

  /**
   * The ID of an address pool that you own.
   * Use this parameter to let Amazon EC2 select an address from the address pool.
   */
  publicIpv4Pool?: Input<string>;

  /**
   * A unique set of Availability Zones, Local Zones, or Wavelength Zones
   * from which AWS advertises IP addresses.
   */
  networkBorderGroup?: Input<string>;

  /**
   * The ID of a customer-owned address pool.
   * Use this parameter to let Amazon EC2 select an address from the address pool.
   */
  customerOwnedIpv4Pool?: Input<string>;

  /**
   * Tags to assign to the Elastic IP.
   * These will be merged with alchemy auto-tags.
   */
  tags?: Record<string, Input<string>>;
}

export interface EipAttrs<_Props extends EipProps = EipProps> {
  /**
   * The allocation ID for the Elastic IP address.
   */
  allocationId: AllocationId;

  /**
   * The Amazon Resource Name (ARN) of the Elastic IP.
   */
  eipArn: `arn:aws:ec2:${RegionID}:${AccountID}:elastic-ip/${this["allocationId"]}`;

  /**
   * The Elastic IP address.
   */
  publicIp: string;

  /**
   * The ID of an address pool.
   */
  publicIpv4Pool?: string;

  /**
   * Indicates whether the Elastic IP address is for use with instances in a VPC or EC2-Classic.
   */
  domain: "vpc" | "standard";

  /**
   * The network border group.
   */
  networkBorderGroup?: string;

  /**
   * The customer-owned IP address.
   */
  customerOwnedIp?: string;

  /**
   * The ID of the customer-owned address pool.
   */
  customerOwnedIpv4Pool?: string;

  /**
   * The carrier IP address associated with the network interface.
   */
  carrierIp?: string;
}
