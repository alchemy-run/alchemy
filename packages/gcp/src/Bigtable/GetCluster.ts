import * as bigtable from "@distilled.cloud/gcp/bigtableadmin_v2";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeBigtableClusterHttpBinding } from "./BindingHttp.ts";
import type { Cluster } from "./Cluster.ts";

export interface GetClusterRequest extends Omit<
  bigtable.GetProjectsInstancesClustersRequest,
  "name"
> {}

/**
 * Runtime binding for Cloud Bigtable `clusters.get`.
 *
 * Bind this operation to a {@link Cluster} in a Function/Action init
 * phase. Provide {@link GetClusterHttp}.
 *
 * ### Observing Clusters
 * **Example:** Read the bound cluster
 * ```typescript
 * const getCluster = yield* GCP.Bigtable.GetCluster(replica);
 * const live = yield* getCluster();
 * ```
 *
 * @binding
 * @category Bigtable
 */
export interface GetCluster extends Binding.Service<
  GetCluster,
  "GCP.Bigtable.GetCluster",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request?: GetClusterRequest,
    ) => Effect.Effect<bigtable.Cluster, bigtable.GetProjectsInstancesClustersError, RuntimeContext>
  >
> {}

export const GetCluster = Binding.Service<GetCluster>("GCP.Bigtable.GetCluster");

/**
 * HTTP implementation of {@link GetCluster}.
 *
 * @layer
 * @provides GCP.Bigtable.GetCluster
 */
export const GetClusterHttp = Layer.effect(
  GetCluster,
  makeBigtableClusterHttpBinding({
    tag: "GCP.Bigtable.GetCluster",
    iam: { role: "roles/bigtable.viewer", on: "bigtable.instance" },
    operation: bigtable.getProjectsInstancesClusters,
  }),
);
