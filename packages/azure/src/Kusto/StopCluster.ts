import type * as kusto from "@distilled.cloud/azure/azure_kusto";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Cluster } from "./Cluster.ts";

export interface StopClusterRequest extends Omit<
  kusto.StopClusterRequest,
  "subscriptionId" | "resourceGroupName" | "clusterName"
> {}

/**
 * Stop an Azure Data Explorer (Kusto) cluster (`POST
 * …/clusters/{cluster}/stop`); compute billing stops and queries fail until it
 * starts again.
 *
 * Binding assigns a custom role (`AzureKustoStopClusterRole`, one per stack,
 * shared by every host of this binding) with exactly the action
 * `Microsoft.Kusto/Clusters/Stop/action`, on the cluster only. On a host with
 * a managed identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an Entra
 * service principal (see `AzureBindings`).
 * Provide {@link StopClusterHttp}.
 *
 * ### Calling StopCluster
 * **Example:** StopCluster from a Function
 * ```typescript
 * // init
 * const stopCluster = yield* Azure.Kusto.StopCluster(cluster);
 *
 * // runtime
 * yield* stopCluster();
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const stopCluster = yield* Azure.Kusto.StopCluster(cluster);
 *   // ...
 * }).pipe(Effect.provide(Azure.Kusto.StopClusterHttp));
 * ```
 *
 * @binding
 * @category Kusto
 */
export interface StopCluster extends Binding.Service<
  StopCluster,
  "Azure.Kusto.StopCluster",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request?: StopClusterRequest,
    ) => Effect.Effect<kusto.StopClusterResponse, kusto.StopClusterError, RuntimeContext>
  >
> {}

export const StopCluster = Binding.Service<StopCluster>("Azure.Kusto.StopCluster");
