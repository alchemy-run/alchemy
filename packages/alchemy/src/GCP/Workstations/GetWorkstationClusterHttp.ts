import * as workstations from "@distilled.cloud/gcp/workstations_v1";
import * as Layer from "effect/Layer";
import { makeClusterHttpBinding } from "./BindingHttp.ts";
import { GetWorkstationCluster } from "./GetWorkstationCluster.ts";

/**
 * HTTP implementation of {@link GetWorkstationCluster}.
 *
 * @layer
 * @provides GCP.Workstations.GetWorkstationCluster
 */
export const GetWorkstationClusterHttp = Layer.effect(
  GetWorkstationCluster,
  makeClusterHttpBinding({
    tag: "GCP.Workstations.GetWorkstationCluster",
    // No narrower predefined role contains workstations.workstationClusters.get.
    iam: { role: "roles/workstations.workstationCreator" },
    operation: workstations.getProjectsLocationsWorkstationClusters,
  }),
);
