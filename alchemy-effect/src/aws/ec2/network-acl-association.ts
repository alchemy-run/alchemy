import type { Input } from "../../input.ts";
import { Resource } from "../../resource.ts";
import type { NetworkAclId } from "./network-acl.ts";
import type { SubnetId } from "./subnet.ts";

export const NetworkAclAssociation = Resource<{
  <const ID extends string, const Props extends NetworkAclAssociationProps>(
    id: ID,
    props: Props,
  ): NetworkAclAssociation<ID, Props>;
}>("AWS.EC2.NetworkAclAssociation");

export interface NetworkAclAssociation<
  ID extends string = string,
  Props extends NetworkAclAssociationProps = NetworkAclAssociationProps,
> extends Resource<
  "AWS.EC2.NetworkAclAssociation",
  ID,
  Props,
  NetworkAclAssociationAttrs<Input.Resolve<Props>>,
  NetworkAclAssociation
> {}

export type NetworkAclAssociationId<ID extends string = string> =
  `aclassoc-${ID}`;
export const NetworkAclAssociationId = <ID extends string>(
  id: ID,
): ID & NetworkAclAssociationId<ID> =>
  `aclassoc-${id}` as ID & NetworkAclAssociationId<ID>;

export interface NetworkAclAssociationProps {
  /**
   * The ID of the new network ACL to associate with the subnet.
   */
  networkAclId: Input<NetworkAclId>;

  /**
   * The ID of the subnet to associate with the network ACL.
   */
  subnetId: Input<SubnetId>;
}

export interface NetworkAclAssociationAttrs<
  Props extends Input.Resolve<NetworkAclAssociationProps>,
> {
  /**
   * The ID of the association between the network ACL and subnet.
   */
  associationId: NetworkAclAssociationId;

  /**
   * The ID of the network ACL.
   */
  networkAclId: Props["networkAclId"];

  /**
   * The ID of the subnet.
   */
  subnetId: Props["subnetId"];
}
