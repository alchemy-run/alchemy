import type * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { AutonomousDatabase } from "./AutonomousDatabase.ts";

export interface RestartAutonomousDatabaseRequest extends Omit<
  oracle.RestartProjectsLocationsAutonomousDatabasesRequest,
  "name"
> {}

/**
 * Runtime binding for Oracle Database `autonomousDatabases.restart`.
 *
 * ### Restarting a database
 * **Example:** Restart the bound database
 * ```typescript
 * const restart = yield* GCP.Oracledatabase.RestartAutonomousDatabase(db);
 * yield* restart();
 * ```
 *
 * @binding
 * @product GCP
 * @category Oracledatabase
 */
export interface RestartAutonomousDatabase extends Binding.Service<
  RestartAutonomousDatabase,
  "GCP.Oracledatabase.RestartAutonomousDatabase",
  (
    database: AutonomousDatabase,
  ) => Effect.Effect<
    (
      request?: RestartAutonomousDatabaseRequest,
    ) => Effect.Effect<
      oracle.Operation,
      oracle.RestartProjectsLocationsAutonomousDatabasesError,
      RuntimeContext
    >
  >
> {}

export const RestartAutonomousDatabase =
  Binding.Service<RestartAutonomousDatabase>(
    "GCP.Oracledatabase.RestartAutonomousDatabase",
  );
