import type { Input } from "alchemy/Input";

/**
 * An AWS VPC a control plane's private address is on. Pools that run nodes
 * on AWS join it and connect to that address.
 */
export interface Network {
  readonly kind: "aws";
  /** The VPC's id. */
  readonly vpcId: Input<string>;
  /** Subnets with a route to the internet, for nodes that need no NAT. */
  readonly subnetIds: ReadonlyArray<Input<string>>;
  /** The security group nodes run with. */
  readonly securityGroupId: Input<string>;
}

/**
 * An AWS VPC, for `Rivet.ControlPlane`'s `network`.
 *
 * ```typescript
 * network: RivetAWS.Network({
 *   vpcId: vpc.vpcId,
 *   subnetIds: vpc.publicSubnetIds,
 *   securityGroupId: nodes.groupId,
 * }),
 * ```
 */
export const Network = (props: Omit<Network, "kind">): Network => ({ kind: "aws", ...props });
