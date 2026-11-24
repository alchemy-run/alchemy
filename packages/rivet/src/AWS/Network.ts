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
 * An AWS VPC, for `Rivet.ControlPlane`'s `network`: an `EC2.Network`, whose
 * public subnets nodes run in, and the security group they run with.
 *
 * ```typescript
 * network: RivetAWS.Network(vpc, nodeGroup),
 * ```
 */
export const Network = (
  vpc: {
    readonly vpcId: Input<string>;
    readonly publicSubnetIds: ReadonlyArray<Input<string>>;
  },
  securityGroup: { readonly groupId: Input<string> },
): Network => ({
  kind: "aws",
  vpcId: vpc.vpcId,
  subnetIds: vpc.publicSubnetIds,
  securityGroupId: securityGroup.groupId,
});
