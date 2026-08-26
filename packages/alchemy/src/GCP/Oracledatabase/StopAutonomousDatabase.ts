import type * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { AutonomousDatabase } from "./AutonomousDatabase.ts";

export interface StopAutonomousDatabaseRequest extends Omit<
  oracle.StopProjectsLocationsAutonomousDatabasesRequest,
  "name"
> {}

/**
 * Runtime binding for Oracle Database `autonomousDatabases.stop`.
 *
 * ### Stopping a database
 * **Example:** Stop the bound database
 * ```typescript
 * const stop = yield* GCP.Oracledatabase.StopAutonomousDatabase(db);
 * yield* stop();
 * ```
 *
 * @binding
 * @product GCP
 * @category Oracledatabase
 */
export interface StopAutonomousDatabase extends Binding.Service<
  StopAutonomousDatabase,
  "GCP.Oracledatabase.StopAutonomousDatabase",
  (
    database: AutonomousDatabase,
  ) => Effect.Effect<
    (
      request?: StopAutonomousDatabaseRequest,
    ) => Effect.Effect<
      oracle.Operation,
      oracle.StopProjectsLocationsAutonomousDatabasesError,
      RuntimeContext
    >
  >
> {}

export const StopAutonomousDatabase = Binding.Service<StopAutonomousDatabase>(
  "GCP.Oracledatabase.StopAutonomousDatabase",
);
