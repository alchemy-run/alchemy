import type * as sql from "@distilled.cloud/azure/sql";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Database } from "./Database.ts";

export interface FailoverDatabaseRequest extends Omit<
  sql.DatabasesFailoverRequest,
  "subscriptionId" | "resourceGroupName" | "serverName" | "databaseName"
> {}

/**
 * Fail a SQL database over to another replica in its region (`POST
 * …/databases/{database}/failover`), e.g. to test an application's retry
 * logic. Azure limits this to one failover every 15 minutes per database.
 *
 * Binding assigns a custom role (`AzureSqlFailoverDatabaseRole`, one per
 * stack, shared by every host of this binding) with exactly the action
 * `Microsoft.Sql/servers/databases/failover/action`, on the database only. On
 * a host with a managed identity (an Azure Function, Function App, Web App,
 * Container App, container group, VM, or AKS workload identity) the role goes
 * to that identity; any other host (a Cloudflare Worker, an AWS Lambda) gets
 * an Entra service principal (see `AzureBindings`).
 * Provide {@link FailoverDatabaseHttp}.
 *
 * ### Calling FailoverDatabase
 * **Example:** FailoverDatabase from a Function
 * ```typescript
 * // init
 * const failoverDatabase = yield* Azure.Sql.FailoverDatabase(database);
 *
 * // runtime
 * yield* failoverDatabase({ replicaType: "Primary" });
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const failoverDatabase = yield* Azure.Sql.FailoverDatabase(database);
 *   // ...
 * }).pipe(Effect.provide(Azure.Sql.FailoverDatabaseHttp));
 * ```
 *
 * @binding
 * @category Sql
 */
export interface FailoverDatabase extends Binding.Service<
  FailoverDatabase,
  "Azure.Sql.FailoverDatabase",
  (
    database: Database,
  ) => Effect.Effect<
    (
      request?: FailoverDatabaseRequest,
    ) => Effect.Effect<sql.DatabasesFailoverResponse, sql.DatabasesFailoverError, RuntimeContext>
  >
> {}

export const FailoverDatabase = Binding.Service<FailoverDatabase>("Azure.Sql.FailoverDatabase");
