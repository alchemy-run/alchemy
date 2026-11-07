import * as container from "@distilled.cloud/gcp/container_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeContainerClustersNodePoolHttpBinding } from "./BindingHttp.ts";
import type { ClustersNodePool } from "./ClustersNodePool.ts";

export interface GetClustersNodePoolRequest extends Omit<
  container.GetProjectsZonesClustersNodePoolsRequest,
  "projectId" | "zone" | "clusterId" | "nodePoolId" | "name"
> {}

/**
 * Runtime binding for GKE zonal `nodePools.get`.
 *
 * Bind this operation to a {@link ClustersNodePool} in a Function/Action
 * init phase. Provide {@link GetClustersNodePoolHttp}.
 *
 * ### Observing Zonal Node Pools
 * **Example:** Read the bound node pool
 * ```typescript
 * const getPool = yield* GCP.Container.GetClustersNodePool(pool);
 * const live = yield* getPool();
 * ```
 *
 * @binding
 * @category Container
 */
export interface GetClustersNodePool extends Binding.Service<
  GetClustersNodePool,
  "GCP.Container.GetClustersNodePool",
  (
    nodePool: ClustersNodePool,
  ) => Effect.Effect<
    (
      request?: GetClustersNodePoolRequest,
    ) => Effect.Effect<
      container.NodePool,
      container.GetProjectsZonesClustersNodePoolsError,
      RuntimeContext
    >
  >
> {}

export const GetClustersNodePool = Binding.Service<GetClustersNodePool>(
  "GCP.Container.GetClustersNodePool",
);

/**
 * HTTP implementation of {@link GetClustersNodePool}.
 *
 * @layer
 * @provides GCP.Container.GetClustersNodePool
 */
export const GetClustersNodePoolHttp = Layer.effect(
  GetClustersNodePool,
  makeContainerClustersNodePoolHttpBinding({
    tag: "GCP.Container.GetClustersNodePool",
    iam: { role: "roles/container.clusterViewer" },
    operation: container.getProjectsZonesClustersNodePools,
  }),
);
