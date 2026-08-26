import * as dataproc from "@distilled.cloud/gcp/dataproc_v1";
import * as Layer from "effect/Layer";
import { makeDataprocClusterHttpBinding } from "./BindingHttp.ts";
import { GetCluster } from "./GetCluster.ts";

/**
 * HTTP implementation of {@link GetCluster}.
 *
 * @layer
 * @provides GCP.Dataproc.GetCluster
 */
export const GetClusterHttp = Layer.effect(
  GetCluster,
  makeDataprocClusterHttpBinding({
    tag: "GCP.Dataproc.GetCluster",
    operation: dataproc.getProjectsRegionsClusters,
  }),
);
