import type * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { AutonomousDatabase } from "./AutonomousDatabase.ts";

export interface StartAutonomousDatabaseRequest extends Omit<
  oracle.StartProjectsLocationsAutonomousDatabasesRequest,
  "name"
> {}

/**
 * Runtime binding for Oracle Database `autonomousDatabases.start`.
 *
 * ### Starting a database
 * **Example:** Start the bound database
 * ```typescript
 * const start = yield* GCP.Oracledatabase.StartAutonomousDatabase(db);
 * yield* start();
 * ```
 *
 * @binding
 * @product GCP
 * @category Oracledatabase
 */
export interface StartAutonomousDatabase extends Binding.Service<
  StartAutonomousDatabase,
  "GCP.Oracledatabase.StartAutonomousDatabase",
  (
    database: AutonomousDatabase,
  ) => Effect.Effect<
    (
      request?: StartAutonomousDatabaseRequest,
    ) => Effect.Effect<
      oracle.Operation,
      oracle.StartProjectsLocationsAutonomousDatabasesError,
      RuntimeContext
    >
  >
> {}

export const StartAutonomousDatabase = Binding.Service<StartAutonomousDatabase>(
  "GCP.Oracledatabase.StartAutonomousDatabase",
);
