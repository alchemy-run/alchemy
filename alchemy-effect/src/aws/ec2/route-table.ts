import type * as EC2 from "itty-aws/ec2";
import type { Input } from "../../input.ts";
import { Resource } from "../../resource.ts";
import type { AccountID } from "../account.ts";
import type { RegionID } from "../region.ts";
import type { VpcId } from "./vpc.ts";

export const RouteTable = Resource<{
  <const ID extends string, const Props extends RouteTableProps>(
    id: ID,
    props: Props,
  ): RouteTable<ID, Props>;
}>("AWS.EC2.RouteTable");

export interface RouteTable<
  ID extends string = string,
  Props extends RouteTableProps = RouteTableProps,
> extends Resource<
  "AWS.EC2.RouteTable",
  ID,
  Props,
  RouteTableAttrs<Input.Resolve<Props>>,
  RouteTable
> {}

export type RouteTableId<ID extends string = string> = `rtb-${ID}`;
export const RouteTableId = <ID extends string>(
  id: ID,
): ID & RouteTableId<ID> => `rtb-${id}` as ID & RouteTableId<ID>;

export interface RouteTableProps {
  /**
   * The VPC to create the route table in.
   * Required.
   */
  vpcId: Input<VpcId>;

  /**
   * Tags to assign to the route table.
   * These will be merged with alchemy auto-tags (alchemy::app, alchemy::stage, alchemy::id).
   */
  tags?: Record<string, Input<string>>;
}

export interface RouteTableAttrs<Props extends RouteTableProps> {
  /**
   * The ID of the VPC the route table is in.
   */
  vpcId: Props["vpcId"];

  /**
   * The ID of the route table.
   */
  routeTableId: RouteTableId;

  /**
   * The Amazon Resource Name (ARN) of the route table.
   */
  routeTableArn: `arn:aws:ec2:${RegionID}:${AccountID}:route-table/${this["routeTableId"]}`;

  /**
   * The ID of the AWS account that owns the route table.
   */
  ownerId?: string;

  /**
   * The associations between the route table and subnets or gateways.
   */
  associations?: Array<{
    /**
     * Whether this is the main route table for the VPC.
     */
    main: boolean;
    /**
     * The ID of the association.
     */
    routeTableAssociationId?: string;
    /**
     * The ID of the route table.
     */
    routeTableId?: string;
    /**
     * The ID of the subnet (if the association is with a subnet).
     */
    subnetId?: string;
    /**
     * The ID of the gateway (if the association is with a gateway).
     */
    gatewayId?: string;
    /**
     * The state of the association.
     */
    associationState?: {
      state: EC2.RouteTableAssociationStateCode;
      statusMessage?: string;
    };
  }>;

  /**
   * The routes in the route table.
   */
  routes?: Array<{
    /**
     * The IPv4 CIDR block used for the destination match.
     */
    destinationCidrBlock?: string;
    /**
     * The IPv6 CIDR block used for the destination match.
     */
    destinationIpv6CidrBlock?: string;
    /**
     * The prefix of the AWS service.
     */
    destinationPrefixListId?: string;
    /**
     * The ID of the egress-only internet gateway.
     */
    egressOnlyInternetGatewayId?: string;
    /**
     * The ID of the gateway (internet gateway or virtual private gateway).
     */
    gatewayId?: string;
    /**
     * The ID of the NAT instance.
     */
    instanceId?: string;
    /**
     * The ID of AWS account that owns the NAT instance.
     */
    instanceOwnerId?: string;
    /**
     * The ID of the NAT gateway.
     */
    natGatewayId?: string;
    /**
     * The ID of the transit gateway.
     */
    transitGatewayId?: string;
    /**
     * The ID of the local gateway.
     */
    localGatewayId?: string;
    /**
     * The ID of the carrier gateway.
     */
    carrierGatewayId?: string;
    /**
     * The ID of the network interface.
     */
    networkInterfaceId?: string;
    /**
     * Describes how the route was created.
     */
    origin: EC2.RouteOrigin;
    /**
     * The state of the route.
     */
    state: EC2.RouteState;
    /**
     * The ID of the VPC peering connection.
     */
    vpcPeeringConnectionId?: string;
    /**
     * The Amazon Resource Name (ARN) of the core network.
     */
    coreNetworkArn?: string;
  }>;

  /**
   * Any virtual private gateway (VGW) propagating routes.
   */
  propagatingVgws?: Array<{
    gatewayId: string;
  }>;
}
