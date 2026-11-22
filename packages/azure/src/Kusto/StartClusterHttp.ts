import * as kusto from "@distilled.cloud/azure/azure_kusto";
import * as Layer from "effect/Layer";
import { makeArmActionBinding } from "../internal/ArmActionBinding.ts";
import type { Cluster } from "./Cluster.ts";
import { StartCluster } from "./StartCluster.ts";

/**
 * Implementation of {@link StartCluster} over the distilled `azure_kusto` ARM
 * operation `StartCluster`. Assigns the custom `AzureKustoStartClusterRole` on
 * the cluster.
 *
 * @layer
 * @provides Azure.Kusto.StartCluster
 */
export const StartClusterHttp = Layer.effect(
  StartCluster,
  makeArmActionBinding({
    tag: "Azure.Kusto.StartCluster",
    operation: kusto.StartCluster,
    role: {
      role: "KustoStartCluster",
      actions: ["Microsoft.Kusto/Clusters/Start/action"],
    },
    resourceId: (cluster: Cluster) => cluster.clusterId,
    identifiers: (id) => ({
      subscriptionId: id.subscriptionId,
      resourceGroupName: id.resourceGroupName,
      clusterName: id.name("clusters"),
    }),
  }),
);
