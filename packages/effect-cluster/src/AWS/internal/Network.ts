/**
 * Resolve a {@link NetworkInput} to the identifiers the cluster's resources
 * take.
 *
 * @internal
 */
import type * as EC2 from "@alchemy.run/aws/EC2";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import type { NetworkInput, ResourceInput } from "../Network.ts";

export interface ResolvedNetwork {
  readonly vpcId: Output.Output<EC2.VpcId>;
  readonly cidrBlock: Output.Output<string>;
  readonly subnetIds: Output.Output<EC2.SubnetId>[];
  readonly publicSubnetIds: Output.Output<EC2.SubnetId>[];
  readonly assignPublicIp: boolean;
}

/** A yielded resource or lookup is an Output; a declaration or `ref` is yielded. */
export const resolveResource = <T, E, R>(input: ResourceInput<T, E, R>): Effect.Effect<T, E, R> =>
  Output.isOutput(input) ? Effect.succeed(input as T) : (input as Effect.Effect<T, E, R>);

export const resolveNetwork = Effect.fn(function* <E, R>(input: NetworkInput<E, R>) {
  if (Effect.isEffect(input)) {
    const network = yield* input;
    // Behind a NAT gateway, the private subnets; else the public ones,
    // where runners reach the internet through public IPs.
    const nat = network.natGateways.length > 0;
    return {
      vpcId: network.vpc.vpcId,
      cidrBlock: network.vpc.cidrBlock,
      subnetIds: nat ? network.privateSubnetIds : network.publicSubnetIds,
      publicSubnetIds: network.publicSubnetIds,
      assignPublicIp: !nat,
    } as ResolvedNetwork;
  }
  const vpc = yield* resolveResource(input.vpc);
  const subnets: EC2.Subnet[] = [];
  for (const subnet of input.subnets) subnets.push(yield* resolveResource(subnet));
  const publicSubnets: EC2.Subnet[] = [];
  for (const subnet of input.publicSubnets ?? []) {
    publicSubnets.push(yield* resolveResource(subnet));
  }
  return {
    vpcId: vpc.vpcId,
    cidrBlock: vpc.cidrBlock,
    subnetIds: subnets.map((subnet) => subnet.subnetId),
    publicSubnetIds: (input.publicSubnets === undefined ? subnets : publicSubnets).map(
      (subnet) => subnet.subnetId,
    ),
    assignPublicIp: input.assignPublicIp ?? false,
  } as ResolvedNetwork;
});
