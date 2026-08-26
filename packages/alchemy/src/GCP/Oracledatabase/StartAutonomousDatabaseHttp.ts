import * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import * as Layer from "effect/Layer";
import { makeOracleNameHttpBinding } from "./BindingHttp.ts";
import { StartAutonomousDatabase } from "./StartAutonomousDatabase.ts";

/**
 * HTTP implementation of {@link StartAutonomousDatabase}.
 *
 * @layer
 * @provides GCP.Oracledatabase.StartAutonomousDatabase
 */
export const StartAutonomousDatabaseHttp = Layer.effect(
  StartAutonomousDatabase,
  makeOracleNameHttpBinding({
    tag: "GCP.Oracledatabase.StartAutonomousDatabase",
    operation: oracle.startProjectsLocationsAutonomousDatabases,
  }),
);
