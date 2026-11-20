import * as container from "@distilled.cloud/gcp/container_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeContainerClusterHttpBinding } from "./BindingHttp.ts";
import type { Cluster } from "./Cluster.ts";

export interface GetClusterRequest extends Omit<
  container.GetProjectsLocationsClustersRequest,
  "name"
> {}

/**
 * Runtime binding for GKE `clusters.get`.
 *
 * Bind this operation to a {@link Cluster} in a Function/Action init
 * phase. Provide {@link GetClusterHttp}.
 *
 * ### Observing Clusters
 * **Example:** Read the bound cluster
 * ```typescript
 * const getCluster = yield* GCP.Container.GetCluster(cluster);
 * const live = yield* getCluster();
 * ```
 *
 * @binding
 * @category Container
 */
export interface GetCluster extends Binding.Service<
  GetCluster,
  "GCP.Container.GetCluster",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request?: GetClusterRequest,
    ) => Effect.Effect<
      container.Cluster,
      container.GetProjectsLocationsClustersError,
      RuntimeContext
    >
  >
> {}

export const GetCluster = Binding.Service<GetCluster>("GCP.Container.GetCluster");

/**
 * HTTP implementation of {@link GetCluster}.
 *
 * @layer
 * @provides GCP.Container.GetCluster
 */
export const GetClusterHttp = Layer.effect(
  GetCluster,
  makeContainerClusterHttpBinding({
    tag: "GCP.Container.GetCluster",
    iam: { role: "roles/container.clusterViewer" },
    operation: container.getProjectsLocationsClusters,
  }),
);
