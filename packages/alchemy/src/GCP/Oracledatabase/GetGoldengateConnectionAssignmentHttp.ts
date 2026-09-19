import * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import * as Layer from "effect/Layer";
import { makeOracleNameHttpBinding } from "./BindingHttp.ts";
import { GetGoldengateConnectionAssignment } from "./GetGoldengateConnectionAssignment.ts";

/**
 * HTTP implementation of {@link GetGoldengateConnectionAssignment}.
 *
 * @layer
 * @provides GCP.Oracledatabase.GetGoldengateConnectionAssignment
 */
export const GetGoldengateConnectionAssignmentHttp = Layer.effect(
  GetGoldengateConnectionAssignment,
  makeOracleNameHttpBinding({
    tag: "GCP.Oracledatabase.GetGoldengateConnectionAssignment",
    operation: oracle.getProjectsLocationsGoldengateConnectionAssignments,
  }),
);
