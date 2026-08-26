import * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import * as Layer from "effect/Layer";
import { makeOracleNameHttpBinding } from "./BindingHttp.ts";
import { RestartAutonomousDatabase } from "./RestartAutonomousDatabase.ts";

/**
 * HTTP implementation of {@link RestartAutonomousDatabase}.
 *
 * @layer
 * @provides GCP.Oracledatabase.RestartAutonomousDatabase
 */
export const RestartAutonomousDatabaseHttp = Layer.effect(
  RestartAutonomousDatabase,
  makeOracleNameHttpBinding({
    tag: "GCP.Oracledatabase.RestartAutonomousDatabase",
    operation: oracle.restartProjectsLocationsAutonomousDatabases,
  }),
);
