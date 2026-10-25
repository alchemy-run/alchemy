import * as kusto from "@distilled.cloud/azure/azure_kusto";
import * as Layer from "effect/Layer";
import { makeArmActionBinding } from "../internal/ArmActionBinding.ts";
import type { Cluster } from "./Cluster.ts";
import { StopCluster } from "./StopCluster.ts";

/**
 * Implementation of {@link StopCluster} over the distilled `azure_kusto` ARM
 * operation `StopCluster`. Assigns the custom `AzureKustoStopClusterRole` on
 * the cluster.
 *
 * @layer
 * @provides Azure.Kusto.StopCluster
 */
export const StopClusterHttp = Layer.effect(
  StopCluster,
  makeArmActionBinding({
    tag: "Azure.Kusto.StopCluster",
    operation: kusto.StopCluster,
    role: {
      role: "KustoStopCluster",
      actions: ["Microsoft.Kusto/Clusters/Stop/action"],
    },
    resourceId: (cluster: Cluster) => cluster.clusterId,
    identifiers: (id) => ({
      subscriptionId: id.subscriptionId,
      resourceGroupName: id.resourceGroupName,
      clusterName: id.name("clusters"),
    }),
  }),
);
