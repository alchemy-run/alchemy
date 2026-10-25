import type * as kusto from "@distilled.cloud/azure/azure_kusto";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Cluster } from "./Cluster.ts";

export interface StartClusterRequest extends Omit<
  kusto.StartClusterRequest,
  "subscriptionId" | "resourceGroupName" | "clusterName"
> {}

/**
 * Start a stopped Azure Data Explorer (Kusto) cluster (`POST
 * …/clusters/{cluster}/start`).
 *
 * Binding assigns a custom role (`AzureKustoStartClusterRole`, one per stack,
 * shared by every host of this binding) with exactly the action
 * `Microsoft.Kusto/Clusters/Start/action`, on the cluster only. On a host with
 * a managed identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an Entra
 * service principal (see `AzureBindings`).
 * Provide {@link StartClusterHttp}.
 *
 * ### Calling StartCluster
 * **Example:** StartCluster from a Function
 * ```typescript
 * // init
 * const startCluster = yield* Azure.Kusto.StartCluster(cluster);
 *
 * // runtime
 * yield* startCluster();
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const startCluster = yield* Azure.Kusto.StartCluster(cluster);
 *   // ...
 * }).pipe(Effect.provide(Azure.Kusto.StartClusterHttp));
 * ```
 *
 * @binding
 * @category Kusto
 */
export interface StartCluster extends Binding.Service<
  StartCluster,
  "Azure.Kusto.StartCluster",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request?: StartClusterRequest,
    ) => Effect.Effect<kusto.StartClusterResponse, kusto.StartClusterError, RuntimeContext>
  >
> {}

export const StartCluster = Binding.Service<StartCluster>("Azure.Kusto.StartCluster");
