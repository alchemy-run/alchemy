import type { SecurityGroupId } from "@/AWS/EC2/SecurityGroup.ts";
import type { SubnetId } from "@/AWS/EC2/Subnet.ts";
import type { VpcId } from "@/AWS/EC2/Vpc.ts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

/**
 * Shared state of the process-wide provisioned-cache VPC. It lives apart from
 * `ProvisionedFixture.ts` so Lambda handlers can read the network without
 * bundling the test harness that deploys it.
 */
export interface ProvisionedNetwork {
  vpcId: VpcId;
  privateSubnetIds: SubnetId[];
  securityGroupId: SecurityGroupId;
  subnetGroupName: string;
}

export const provisionedNetworkState = {
  ready: Deferred.makeUnsafe<ProvisionedNetwork, unknown>(),
  started: false,
};

// VPC placement is deploy-time configuration; a deployed function never reads it.
const runtimeNetwork: ProvisionedNetwork = {
  vpcId: "" as VpcId,
  privateSubnetIds: [],
  securityGroupId: "" as SecurityGroupId,
  subnetGroupName: "",
};

/** Resolved IDs of the process-wide provisioned-cache VPC. */
export const getProvisionedNetwork = Effect.suspend(() =>
  globalThis.__ALCHEMY_RUNTIME__
    ? Effect.succeed(runtimeNetwork)
    : provisionedNetworkState.started
      ? Deferred.await(provisionedNetworkState.ready).pipe(Effect.orDie)
      : Effect.die(
          "provisioned network was not acquired; call shareProvisionedNetwork in the test file",
        ),
);
