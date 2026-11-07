import * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeOracleNameHttpBinding } from "./BindingHttp.ts";
import type { CloudVmCluster } from "./CloudVmCluster.ts";

export interface GetCloudVmClusterRequest extends Omit<
  oracle.GetProjectsLocationsCloudVmClustersRequest,
  "name"
> {}

/**
 * Runtime binding for Oracle Database `cloudVmClusters.get`.
 *
 * ### Observing VM Clusters
 * **Example:** Read the bound cluster
 * ```typescript
 * const get = yield* GCP.OracleDatabase.GetCloudVmCluster(cluster);
 * const live = yield* get();
 * ```
 *
 * @binding
 * @category OracleDatabase
 */
export interface GetCloudVmCluster extends Binding.Service<
  GetCloudVmCluster,
  "GCP.OracleDatabase.GetCloudVmCluster",
  (
    cluster: CloudVmCluster,
  ) => Effect.Effect<
    (
      request?: GetCloudVmClusterRequest,
    ) => Effect.Effect<
      oracle.CloudVmCluster,
      oracle.GetProjectsLocationsCloudVmClustersError,
      RuntimeContext
    >
  >
> {}

export const GetCloudVmCluster = Binding.Service<GetCloudVmCluster>(
  "GCP.OracleDatabase.GetCloudVmCluster",
);

/**
 * HTTP implementation of {@link GetCloudVmCluster}.
 *
 * @layer
 * @provides GCP.OracleDatabase.GetCloudVmCluster
 */
export const GetCloudVmClusterHttp = Layer.effect(
  GetCloudVmCluster,
  makeOracleNameHttpBinding({
    tag: "GCP.OracleDatabase.GetCloudVmCluster",
    operation: oracle.getProjectsLocationsCloudVmClusters,
    iam: { role: "roles/oracledatabase.cloudVmClusterViewer" },
  }),
);
