import * as Azure from "@/Azure";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const tags = ["provider:azure", "provider:azure:discovery", "live"];

/** Discovery regions; the preview is only rolled out in a few. */
export const location = "eastus";

export const subscription = Effect.map(
  Azure.AzureEnvironment.current,
  (env) => env.subscriptionId,
);

/** Poll an out-of-band GET until it reports a typed not-found. */
export const waitGone = <A, R>(get: Effect.Effect<A, AzureOpError, R>) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (status) => status === "gone",
      times: 30,
    }),
  );

/** A resource group to hold the probe PUT of an ungated rejection test. */
export const probeGroup = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("ProbeGroup", {
    location,
  });
  return { group };
});

/** Network and identities a supercomputer needs. */
export const supercomputerPrerequisites = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", { location });
  const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
    resourceGroup: group.resourceGroupName,
    addressPrefixes: ["10.40.0.0/16"],
  });
  const system = yield* Azure.Network.Subnet("System", {
    resourceGroup: group.resourceGroupName,
    virtualNetwork: vnet.virtualNetworkName,
    addressPrefix: "10.40.0.0/22",
  });
  const management = yield* Azure.Network.Subnet("Management", {
    resourceGroup: group.resourceGroupName,
    virtualNetwork: vnet.virtualNetworkName,
    addressPrefix: "10.40.4.0/24",
    delegations: [
      { serviceName: "Microsoft.ContainerService/managedClusters" },
    ],
  });
  const nodes = yield* Azure.Network.Subnet("Nodes", {
    resourceGroup: group.resourceGroupName,
    virtualNetwork: vnet.virtualNetworkName,
    addressPrefix: "10.40.8.0/22",
  });
  const cluster = yield* Azure.ManagedIdentity.UserAssignedIdentity("Cluster", {
    resourceGroup: group.resourceGroupName,
    location,
  });
  const kubelet = yield* Azure.ManagedIdentity.UserAssignedIdentity("Kubelet", {
    resourceGroup: group.resourceGroupName,
    location,
  });
  const workload = yield* Azure.ManagedIdentity.UserAssignedIdentity(
    "Workload",
    { resourceGroup: group.resourceGroupName, location },
  );
  // The kubelet identity must be able to act as the cluster identity.
  yield* Azure.Authorization.RoleAssignment("KubeletOperator", {
    scope: cluster.identityId,
    principalId: kubelet.principalId,
    roleDefinitionId: "f1a07417-d97a-45cb-824c-7a7467783830",
    principalType: "ServicePrincipal",
  });
  return { group, system, management, nodes, cluster, kubelet, workload };
});
