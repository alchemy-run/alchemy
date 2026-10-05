import * as Azure from "@/Azure";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const tags = ["provider:azure", "provider:azure:servicefabric", "live"];

export const subscription = Effect.map(
  Azure.AzureEnvironment.current,
  (env) => env.subscriptionId,
);

/** Fixed test credentials: the cluster never gets nodes in the ungated tests. */
export const clusterAuth = {
  adminUserName: "sfadmin",
  adminPassword: Redacted.make("Alchemy-Sf-Test-1!"),
  clients: [
    {
      isAdmin: true,
      thumbprint: "1AB2C3D4E5F60718293A4B5C6D7E8F9012345678",
    },
  ],
};

/** Poll an out-of-band GET until it reports a typed not-found. */
export const waitGone = <A, R>(
  get: Effect.Effect<A, AzureOpError, R>,
  times = 60,
) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (status) => status === "gone",
      times,
    }),
  );

/**
 * SAS URL of a `.sfpkg` package whose manifest declares application type
 * `appTypeName` version `appTypeVersion` with a stateless service type
 * `serviceTypeName` (e.g. the Service Fabric "Voting" sample packaged as
 * VotingType 1.0.0 / VotingWebType). Application tests need it and a
 * cluster with nodes.
 */
export const appPackage = {
  url: process.env.AZURE_TEST_SF_APP_PACKAGE_URL,
  appTypeName: process.env.AZURE_TEST_SF_APP_TYPE ?? "VotingType",
  appTypeVersion: process.env.AZURE_TEST_SF_APP_VERSION ?? "1.0.0",
  serviceTypeName: process.env.AZURE_TEST_SF_SERVICE_TYPE ?? "VotingWebType",
};

/**
 * Region and VM size for clusters with nodes. Standard_D2s_v3 is
 * capacity-restricted (`SkuNotAvailable`) for the testing subscription in
 * westus2; Standard_D2s_v4 is unrestricted in westus3.
 */
export const nodeLocation = "westus3";
export const nodeVmSize = "Standard_D2s_v4";

/** Resource group, Basic cluster, and a 3-node primary node type. */
export const clusterWithNodes = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: nodeLocation,
  });
  const cluster = yield* Azure.ServiceFabric.ManagedCluster("Cluster", {
    resourceGroup: group.resourceGroupName,
    location: group.location,
    ...clusterAuth,
  });
  const nodeType = yield* Azure.ServiceFabric.NodeType("Primary", {
    resourceGroup: group.resourceGroupName,
    cluster: cluster.managedClusterName,
    isPrimary: true,
    vmInstanceCount: 3,
    vmSize: nodeVmSize,
  });
  return { group, cluster, nodeType };
});
