import type * as sql from "@distilled.cloud/azure/sql";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Database } from "./Database.ts";

export interface ResumeDatabaseRequest extends Omit<
  sql.ResumeDatabaseRequest,
  "subscriptionId" | "resourceGroupName" | "serverName" | "databaseName"
> {}

/**
 * Resume a paused dedicated SQL pool (formerly SQL Data Warehouse) database
 * (`POST …/databases/{database}/resume`). Other editions fail with
 * `FeatureDisabledOnSelectedEdition`.
 *
 * Binding assigns a custom role (`AzureSqlResumeDatabaseRole`, one per stack,
 * shared by every host of this binding) with exactly the action
 * `Microsoft.Sql/servers/databases/resume/action`, on the database only. On a
 * host with a managed identity (an Azure Function, Function App, Web App,
 * Container App, container group, VM, or AKS workload identity) the role goes
 * to that identity; any other host (a Cloudflare Worker, an AWS Lambda) gets
 * an Entra service principal (see `AzureBindings`).
 * Provide {@link ResumeDatabaseHttp}.
 *
 * ### Calling ResumeDatabase
 * **Example:** ResumeDatabase from a Function
 * ```typescript
 * // init
 * const resumeDatabase = yield* Azure.Sql.ResumeDatabase(database);
 *
 * // runtime
 * yield* resumeDatabase();
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const resumeDatabase = yield* Azure.Sql.ResumeDatabase(database);
 *   // ...
 * }).pipe(Effect.provide(Azure.Sql.ResumeDatabaseHttp));
 * ```
 *
 * @binding
 * @category Sql
 */
export interface ResumeDatabase extends Binding.Service<
  ResumeDatabase,
  "Azure.Sql.ResumeDatabase",
  (
    database: Database,
  ) => Effect.Effect<
    (
      request?: ResumeDatabaseRequest,
    ) => Effect.Effect<sql.ResumeDatabaseResponse, sql.ResumeDatabaseError, RuntimeContext>
  >
> {}

export const ResumeDatabase = Binding.Service<ResumeDatabase>("Azure.Sql.ResumeDatabase");
