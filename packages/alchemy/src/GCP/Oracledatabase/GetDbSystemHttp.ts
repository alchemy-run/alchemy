import * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import * as Layer from "effect/Layer";
import { makeOracleNameHttpBinding } from "./BindingHttp.ts";
import { GetDbSystem } from "./GetDbSystem.ts";

/**
 * HTTP implementation of {@link GetDbSystem}.
 *
 * @layer
 * @provides GCP.Oracledatabase.GetDbSystem
 */
export const GetDbSystemHttp = Layer.effect(
  GetDbSystem,
  makeOracleNameHttpBinding({
    tag: "GCP.Oracledatabase.GetDbSystem",
    operation: oracle.getProjectsLocationsDbSystems,
  }),
);
