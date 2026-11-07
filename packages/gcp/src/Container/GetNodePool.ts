import * as container from "@distilled.cloud/gcp/container_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeContainerNodePoolHttpBinding } from "./BindingHttp.ts";
import type { NodePool } from "./NodePool.ts";

export interface GetNodePoolRequest extends Omit<
  container.GetProjectsLocationsClustersNodePoolsRequest,
  "name"
> {}

/**
 * Runtime binding for GKE `nodePools.get`.
 *
 * Bind this operation to a {@link NodePool} in a Function/Action init
 * phase. Provide {@link GetNodePoolHttp}.
 *
 * ### Observing Node Pools
 * **Example:** Read the bound node pool
 * ```typescript
 * const getNodePool = yield* GCP.Container.GetNodePool(pool);
 * const live = yield* getNodePool();
 * ```
 *
 * @binding
 * @category Container
 */
export interface GetNodePool extends Binding.Service<
  GetNodePool,
  "GCP.Container.GetNodePool",
  (
    nodePool: NodePool,
  ) => Effect.Effect<
    (
      request?: GetNodePoolRequest,
    ) => Effect.Effect<
      container.NodePool,
      container.GetProjectsLocationsClustersNodePoolsError,
      RuntimeContext
    >
  >
> {}

export const GetNodePool = Binding.Service<GetNodePool>("GCP.Container.GetNodePool");

/**
 * HTTP implementation of {@link GetNodePool}.
 *
 * @layer
 * @provides GCP.Container.GetNodePool
 */
export const GetNodePoolHttp = Layer.effect(
  GetNodePool,
  makeContainerNodePoolHttpBinding({
    tag: "GCP.Container.GetNodePool",
    iam: { role: "roles/container.clusterViewer" },
    operation: container.getProjectsLocationsClustersNodePools,
  }),
);
