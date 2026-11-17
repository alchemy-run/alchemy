// src/Infra.ts
import * as AWS from "@alchemy.run/aws";
import * as Effect from "effect/Effect";

/**
 * Private subnets behind one NAT gateway. ECS instances pull the sandbox
 * image through it, and the Api Function reaches the ECS API through it.
 */
export const Network = AWS.EC2.Network("Network", {
  cidrBlock: "10.0.0.0/16",
  nat: "single",
});

export const Cluster = AWS.ECS.Cluster("Cluster", {});

/**
 * Managed Instances capacity for Nitro Sandboxes. ECS launches an instance
 * when a sandbox needs one and drains it when it's empty. The provider
 * creates the roles, the instance profile and the security groups, and picks
 * instance types that support Nitro Sandboxes.
 */
export const Capacity = Effect.gen(function* () {
  const cluster = yield* Cluster;
  const network = yield* Network;
  return yield* AWS.ECS.CapacityProvider("Capacity", {
    cluster: cluster.clusterName,
    managedInstancesProvider: {
      instanceLaunchTemplate: {
        networkConfiguration: { subnets: network.privateSubnetIds },
        nitroEnclavesEnabled: true,
      },
    },
  });
});
