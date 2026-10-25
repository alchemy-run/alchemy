import type * as sql from "@distilled.cloud/azure/sql";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Database } from "./Database.ts";

export interface PauseDatabaseRequest extends Omit<
  sql.PauseDatabaseRequest,
  "subscriptionId" | "resourceGroupName" | "serverName" | "databaseName"
> {}

/**
 * Pause a dedicated SQL pool (formerly SQL Data Warehouse) database on a
 * logical SQL server (`POST …/databases/{database}/pause`); compute billing
 * stops. Other editions fail with `FeatureDisabledOnSelectedEdition`.
 *
 * Binding assigns a custom role (`AzureSqlPauseDatabaseRole`, one per stack,
 * shared by every host of this binding) with exactly the action
 * `Microsoft.Sql/servers/databases/pause/action`, on the database only. On a
 * host with a managed identity (an Azure Function, Function App, Web App,
 * Container App, container group, VM, or AKS workload identity) the role goes
 * to that identity; any other host (a Cloudflare Worker, an AWS Lambda) gets
 * an Entra service principal (see `AzureBindings`).
 * Provide {@link PauseDatabaseHttp}.
 *
 * ### Calling PauseDatabase
 * **Example:** PauseDatabase from a Function
 * ```typescript
 * // init
 * const pauseDatabase = yield* Azure.Sql.PauseDatabase(database);
 *
 * // runtime
 * yield* pauseDatabase();
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const pauseDatabase = yield* Azure.Sql.PauseDatabase(database);
 *   // ...
 * }).pipe(Effect.provide(Azure.Sql.PauseDatabaseHttp));
 * ```
 *
 * @binding
 * @category Sql
 */
export interface PauseDatabase extends Binding.Service<
  PauseDatabase,
  "Azure.Sql.PauseDatabase",
  (
    database: Database,
  ) => Effect.Effect<
    (
      request?: PauseDatabaseRequest,
    ) => Effect.Effect<sql.PauseDatabaseResponse, sql.PauseDatabaseError, RuntimeContext>
  >
> {}

export const PauseDatabase = Binding.Service<PauseDatabase>("Azure.Sql.PauseDatabase");
