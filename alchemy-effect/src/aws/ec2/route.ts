import type * as EC2 from "itty-aws/ec2";
import type { Input } from "../../input.ts";
import { Resource } from "../../resource.ts";
import type { RouteTableId } from "./route-table.ts";

export const Route = Resource<{
  <const ID extends string, const Props extends RouteProps>(
    id: ID,
    props: Props,
  ): Route<ID, Props>;
}>("AWS.EC2.Route");

export interface Route<
  ID extends string = string,
  Props extends RouteProps = RouteProps,
> extends Resource<
    "AWS.EC2.Route",
    ID,
    Props,
    RouteAttrs<Input.Resolve<Props>>,
    Route
  > {}

export interface RouteProps {
  /**
   * The ID of the route table where the route will be added.
   * Required.
   */
  routeTableId: Input<RouteTableId>;

  /**
   * The IPv4 CIDR block used for the destination match.
   * Either destinationCidrBlock, destinationIpv6CidrBlock, or destinationPrefixListId is required.
   * @example "0.0.0.0/0"
   */
  destinationCidrBlock?: string;

  /**
   * The IPv6 CIDR block used for the destination match.
   * Either destinationCidrBlock, destinationIpv6CidrBlock, or destinationPrefixListId is required.
   * @example "::/0"
   */
  destinationIpv6CidrBlock?: string;

  /**
   * The ID of a prefix list used for the destination match.
   * Either destinationCidrBlock, destinationIpv6CidrBlock, or destinationPrefixListId is required.
   */
  destinationPrefixListId?: string;

  // ---- Target properties (exactly one required) ----

  /**
   * The ID of an internet gateway or virtual private gateway.
   */
  gatewayId?: Input<string>;

  /**
   * The ID of a NAT gateway.
   */
  natGatewayId?: Input<string>;

  /**
   * The ID of a NAT instance in your VPC.
   * This operation fails unless exactly one network interface is attached.
   */
  instanceId?: Input<string>;

  /**
   * The ID of a network interface.
   */
  networkInterfaceId?: Input<string>;

  /**
   * The ID of a VPC peering connection.
   */
  vpcPeeringConnectionId?: Input<string>;

  /**
   * The ID of a transit gateway.
   */
  transitGatewayId?: Input<string>;

  /**
   * The ID of a local gateway.
   */
  localGatewayId?: Input<string>;

  /**
   * The ID of a carrier gateway.
   * Use for Wavelength Zones only.
   */
  carrierGatewayId?: Input<string>;

  /**
   * The ID of an egress-only internet gateway.
   * IPv6 traffic only.
   */
  egressOnlyInternetGatewayId?: Input<string>;

  /**
   * The Amazon Resource Name (ARN) of the core network.
   */
  coreNetworkArn?: Input<string>;

  /**
   * The ID of a VPC endpoint for Gateway Load Balancer.
   */
  vpcEndpointId?: Input<string>;
}

export interface RouteAttrs<Props extends RouteProps> {
  /**
   * The ID of the route table.
   */
  routeTableId: Props["routeTableId"];

  /**
   * The IPv4 CIDR block used for the destination match.
   */
  destinationCidrBlock?: Props["destinationCidrBlock"];

  /**
   * The IPv6 CIDR block used for the destination match.
   */
  destinationIpv6CidrBlock?: Props["destinationIpv6CidrBlock"];

  /**
   * The ID of a prefix list used for the destination match.
   */
  destinationPrefixListId?: Props["destinationPrefixListId"];

  /**
   * Describes how the route was created.
   */
  origin: EC2.RouteOrigin;

  /**
   * The state of the route.
   */
  state: EC2.RouteState;

  /**
   * The ID of the gateway (if applicable).
   */
  gatewayId?: string;

  /**
   * The ID of the NAT gateway (if applicable).
   */
  natGatewayId?: string;

  /**
   * The ID of the NAT instance (if applicable).
   */
  instanceId?: string;

  /**
   * The ID of the network interface (if applicable).
   */
  networkInterfaceId?: string;

  /**
   * The ID of the VPC peering connection (if applicable).
   */
  vpcPeeringConnectionId?: string;

  /**
   * The ID of the transit gateway (if applicable).
   */
  transitGatewayId?: string;

  /**
   * The ID of the local gateway (if applicable).
   */
  localGatewayId?: string;

  /**
   * The ID of the carrier gateway (if applicable).
   */
  carrierGatewayId?: string;

  /**
   * The ID of the egress-only internet gateway (if applicable).
   */
  egressOnlyInternetGatewayId?: string;

  /**
   * The Amazon Resource Name (ARN) of the core network (if applicable).
   */
  coreNetworkArn?: string;
}
