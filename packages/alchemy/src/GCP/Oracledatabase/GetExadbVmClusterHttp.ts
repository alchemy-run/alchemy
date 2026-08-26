import * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import * as Layer from "effect/Layer";
import { makeOracleNameHttpBinding } from "./BindingHttp.ts";
import { GetExadbVmCluster } from "./GetExadbVmCluster.ts";

/**
 * HTTP implementation of {@link GetExadbVmCluster}.
 *
 * @layer
 * @provides GCP.Oracledatabase.GetExadbVmCluster
 */
export const GetExadbVmClusterHttp = Layer.effect(
  GetExadbVmCluster,
  makeOracleNameHttpBinding({
    tag: "GCP.Oracledatabase.GetExadbVmCluster",
    operation: oracle.getProjectsLocationsExadbVmClusters,
  }),
);
