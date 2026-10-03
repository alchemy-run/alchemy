import * as Azure from "@/Azure";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const tags = ["provider:azure", "provider:azure:networkcloud", "live"];

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
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
  );

/**
 * ARM ID of a deployed Nexus cluster's custom location
 * (`clusterExtendedLocation`). Only operator subscriptions with Nexus
 * hardware have one.
 */
export const customLocationId =
  process.env.AZURE_NEXUS_CUSTOM_LOCATION_ID ?? "";

/** A custom location ARM ID that does not exist, for rejection probes. */
export const bogusCustomLocation = (
  subscriptionId: string,
  resourceGroupName: string,
) => ({
  name: `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers/Microsoft.ExtendedLocation/customLocations/nonexus`,
  type: "CustomLocation" as const,
});

/** Operator Nexus fixtures for the gated lifecycles (operator accounts only). */
export const nexus = {
  /** ARM ID of a deployed Nexus cluster. */
  clusterId: process.env.AZURE_NEXUS_CLUSTER_ID ?? "",
  /** ARM ID of a Network Fabric L2 isolation domain. */
  l2IsolationDomainId: process.env.AZURE_NEXUS_L2_ISOLATION_DOMAIN_ID ?? "",
  /** ARM ID of a Network Fabric L3 isolation domain. */
  l3IsolationDomainId: process.env.AZURE_NEXUS_L3_ISOLATION_DOMAIN_ID ?? "",
  /** ARM ID of a Network Fabric controller. */
  fabricControllerId: process.env.AZURE_NEXUS_FABRIC_CONTROLLER_ID ?? "",
  /** Custom location of a cluster manager. */
  managerCustomLocationId:
    process.env.AZURE_NEXUS_MANAGER_CUSTOM_LOCATION_ID ?? "",
  /** ARM ID of an undeployed Network Fabric for a new cluster. */
  networkFabricId: process.env.AZURE_NEXUS_FABRIC_ID ?? "",
  /** ARM ID of the aggregator network rack. */
  rackId: process.env.AZURE_NEXUS_RACK_ID ?? "",
  /** ARM ID of the rack SKU. */
  rackSkuId: process.env.AZURE_NEXUS_RACK_SKU_ID ?? "",
  /** Serial number of the rack. */
  rackSerialNumber: process.env.AZURE_NEXUS_RACK_SERIAL ?? "",
  /** Cluster version to deploy. */
  clusterVersion: process.env.AZURE_NEXUS_CLUSTER_VERSION ?? "",
  /** VM image (`registry/repo:tag`) for virtual machines. */
  vmImage: process.env.AZURE_NEXUS_VM_IMAGE ?? "",
  /** Kubernetes version for Nexus Kubernetes clusters. */
  kubernetesVersion: process.env.AZURE_NEXUS_KUBERNETES_VERSION ?? "",
};

/** Resource group and name of `nexus.clusterId`. */
export const nexusCluster = {
  resourceGroup: nexus.clusterId.match(/\/resourceGroups\/([^/]+)/i)?.[1] ?? "",
  name: nexus.clusterId.split("/").pop() ?? "",
};

/** An Entra ID group object ID used by the key set lifecycles. */
export const azureGroupId =
  process.env.AZURE_NEXUS_AZURE_GROUP_ID ??
  "00000000-0000-0000-0000-000000000000";

/** A syntactically valid SSH public key for fixtures. */
export const sshKey = {
  keyData:
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGb2ZnKvQ5mOqJQ3xJpZ5fQ3pYxv1Yb7m1t9R5n0YcXl alchemy",
};
