import type * as EC2 from "itty-aws/ec2";
import type { Input } from "../../input.ts";
import { Resource } from "../../resource.ts";
import type { RouteTableId } from "./route-table.ts";
import type { SubnetId } from "./subnet.ts";

export const RouteTableAssociation = Resource<{
  <const ID extends string, const Props extends RouteTableAssociationProps>(
    id: ID,
    props: Props,
  ): RouteTableAssociation<ID, Props>;
}>("AWS.EC2.RouteTableAssociation");

export interface RouteTableAssociation<
  ID extends string = string,
  Props extends RouteTableAssociationProps = RouteTableAssociationProps,
> extends Resource<
    "AWS.EC2.RouteTableAssociation",
    ID,
    Props,
    RouteTableAssociationAttrs<Input.Resolve<Props>>,
    RouteTableAssociation
  > {}

export type RouteTableAssociationId<ID extends string = string> =
  `rtbassoc-${ID}`;
export const RouteTableAssociationId = <ID extends string>(
  id: ID,
): ID & RouteTableAssociationId<ID> =>
  `rtbassoc-${id}` as ID & RouteTableAssociationId<ID>;

export interface RouteTableAssociationProps {
  /**
   * The ID of the route table.
   * Required.
   */
  routeTableId: Input<RouteTableId>;

  /**
   * The ID of the subnet to associate with the route table.
   * Either subnetId or gatewayId is required, but not both.
   */
  subnetId?: Input<SubnetId>;

  /**
   * The ID of the gateway (internet gateway or virtual private gateway) to associate with the route table.
   * Either subnetId or gatewayId is required, but not both.
   */
  gatewayId?: Input<string>;
}

export interface RouteTableAssociationAttrs<
  Props extends RouteTableAssociationProps,
> {
  /**
   * The ID of the association.
   */
  associationId: RouteTableAssociationId;

  /**
   * The ID of the route table.
   */
  routeTableId: Props["routeTableId"];

  /**
   * The ID of the subnet (if the association is with a subnet).
   */
  subnetId?: Props["subnetId"];

  /**
   * The ID of the gateway (if the association is with a gateway).
   */
  gatewayId?: Props["gatewayId"];

  /**
   * The state of the association.
   */
  associationState: {
    state: EC2.RouteTableAssociationStateCode;
    statusMessage?: string;
  };
}
