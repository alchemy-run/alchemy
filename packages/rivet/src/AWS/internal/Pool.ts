/**
 * What the AWS pools share: the network their nodes run in.
 *
 * @internal
 */
import * as EC2 from "@alchemy.run/aws/EC2";
import * as Effect from "effect/Effect";
import type { ClusterNetwork, ClusterShape } from "../../Cluster.ts";

export { nodeEnvironment } from "../../internal/PoolHost.ts";

/** The cluster has no VPC for nodes to join. */
const ownNetwork = { kind: "own" } as const;

export type PoolNetwork = Extract<ClusterNetwork, { kind: "aws" }> | typeof ownNetwork;

/**
 * Nodes join the control plane's VPC when it has one, and a VPC of the
 * pool's own otherwise (Rivet Cloud, or a control plane elsewhere).
 */
export const poolNetworkOf = (cluster: ClusterShape): PoolNetwork =>
  cluster.network?.kind === "aws" ? cluster.network : ownNetwork;

/** The network to run nodes in: the cluster's VPC, or public subnets of the pool's own. */
export const resolvePoolNetwork = Effect.fn(function* (
  id: string,
  network: PoolNetwork,
  cidrBlock: string | undefined,
) {
  if (network.kind === "aws") return network;
  const vpc = yield* EC2.Network(`${id}Network`, {
    cidrBlock: cidrBlock ?? "10.43.0.0/16",
    availabilityZones: 2,
  });
  const group = yield* EC2.SecurityGroup(`${id}NodeGroup`, {
    vpcId: vpc.vpcId,
    description: "Rivet nodes",
    egress: [{ ipProtocol: "-1", cidrIpv4: "0.0.0.0/0" }],
  });
  return {
    kind: "aws" as const,
    vpcId: vpc.vpcId,
    subnetIds: vpc.publicSubnetIds,
    securityGroupId: group.groupId,
  };
});
