import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as kafka from "@distilled.cloud/gcp/managedkafka_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import { makeManagedKafkaHttpBinding } from "./BindingHttp.ts";
import type { Cluster } from "./Cluster.ts";

export interface GetClusterRequest extends Omit<
  kafka.GetProjectsLocationsClustersRequest,
  "name"
> {}

/**
 * Runtime binding for Managed Kafka `clusters.get`.
 *
 * Bind this operation to a {@link Cluster} in a Function/Action init
 * phase. Provide {@link GetClusterHttp}.
 *
 * ### Observing Clusters
 * **Example:** Read the bound cluster
 * ```typescript
 * const getCluster = yield* GCP.ManagedKafka.GetCluster(cluster);
 * const live = yield* getCluster();
 * ```
 *
 * @binding
 * @category ManagedKafka
 */
export interface GetCluster extends Binding.Service<
  GetCluster,
  "GCP.ManagedKafka.GetCluster",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request?: GetClusterRequest,
    ) => Effect.Effect<kafka.Cluster, kafka.GetProjectsLocationsClustersError, RuntimeContext>
  >
> {}

export const GetCluster = Binding.Service<GetCluster>("GCP.ManagedKafka.GetCluster");

/**
 * HTTP implementation of {@link GetCluster}.
 *
 * @layer
 * @provides GCP.ManagedKafka.GetCluster
 */
export const GetClusterHttp: Layer.Layer<GetCluster, never, Credentials | HttpClient.HttpClient> =
  Layer.effect(
    GetCluster,
    makeManagedKafkaHttpBinding<Cluster>()<
      kafka.GetProjectsLocationsClustersRequest,
      kafka.Cluster,
      kafka.GetProjectsLocationsClustersError
    >({
      tag: "GCP.ManagedKafka.GetCluster",
      iam: { role: "roles/managedkafka.viewer", scopeByCondition: true },
      operation: kafka.getProjectsLocationsClusters,
    }),
  );
