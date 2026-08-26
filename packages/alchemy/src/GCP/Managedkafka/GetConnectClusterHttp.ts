import * as kafka from "@distilled.cloud/gcp/managedkafka_v1";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { makeManagedKafkaHttpBinding } from "./BindingHttp.ts";
import type { ConnectCluster } from "./ConnectCluster.ts";
import { GetConnectCluster } from "./GetConnectCluster.ts";

/**
 * HTTP implementation of {@link GetConnectCluster}.
 *
 * @layer
 * @provides GCP.Managedkafka.GetConnectCluster
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
    tag: "GCP.Managedkafka.GetConnectCluster",
    operation: kafka.getProjectsLocationsConnectClusters,
  }),
);
