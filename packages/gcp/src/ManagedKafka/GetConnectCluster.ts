import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as kafka from "@distilled.cloud/gcp/managedkafka_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import { makeManagedKafkaHttpBinding } from "./BindingHttp.ts";
import type { ConnectCluster } from "./ConnectCluster.ts";

export interface GetConnectClusterRequest extends Omit<
  kafka.GetProjectsLocationsConnectClustersRequest,
  "name"
> {}

/**
 * Runtime binding for Managed Kafka `connectClusters.get`.
 *
 * Bind this operation to a {@link ConnectCluster} in a Function/Action
 * init phase. Provide {@link GetConnectClusterHttp}.
 *
 * ### Observing Connect Clusters
 * **Example:** Read the bound Connect cluster
 * ```typescript
 * const getConnect = yield* GCP.ManagedKafka.GetConnectCluster(connect);
 * const live = yield* getConnect();
 * ```
 *
 * @binding
 * @category ManagedKafka
 */
export interface GetConnectCluster extends Binding.Service<
  GetConnectCluster,
  "GCP.ManagedKafka.GetConnectCluster",
  (
    cluster: ConnectCluster,
  ) => Effect.Effect<
    (
      request?: GetConnectClusterRequest,
    ) => Effect.Effect<
      kafka.ConnectCluster,
      kafka.GetProjectsLocationsConnectClustersError,
      RuntimeContext
    >
  >
> {}

export const GetConnectCluster = Binding.Service<GetConnectCluster>(
  "GCP.ManagedKafka.GetConnectCluster",
);

/**
 * HTTP implementation of {@link GetConnectCluster}.
 *
 * @layer
 * @provides GCP.ManagedKafka.GetConnectCluster
 */
export const GetConnectClusterHttp: Layer.Layer<
  GetConnectCluster,
  never,
  Credentials | HttpClient.HttpClient
> = Layer.effect(
  GetConnectCluster,
  makeManagedKafkaHttpBinding<ConnectCluster>()<
    kafka.GetProjectsLocationsConnectClustersRequest,
    kafka.ConnectCluster,
    kafka.GetProjectsLocationsConnectClustersError
  >({
    tag: "GCP.ManagedKafka.GetConnectCluster",
    iam: { role: "roles/managedkafka.viewer", scopeByCondition: true },
    operation: kafka.getProjectsLocationsConnectClusters,
  }),
);
