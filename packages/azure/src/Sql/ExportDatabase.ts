import type * as sql from "@distilled.cloud/azure/sql";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Database } from "./Database.ts";

export interface ExportDatabaseRequest extends Omit<
  sql.ExportDatabaseRequest,
  "subscriptionId" | "resourceGroupName" | "serverName" | "databaseName"
> {}

/**
 * Export a SQL database to a BACPAC file in a storage container (`POST
 * …/databases/{database}/export`). The export runs in the background after
 * Azure accepts it.
 *
 * Binding assigns a custom role (`AzureSqlExportDatabaseRole`, one per stack,
 * shared by every host of this binding) with exactly the action
 * `Microsoft.Sql/servers/databases/export/action`, on the database only. On a
 * host with a managed identity (an Azure Function, Function App, Web App,
 * Container App, container group, VM, or AKS workload identity) the role goes
 * to that identity; any other host (a Cloudflare Worker, an AWS Lambda) gets
 * an Entra service principal (see `AzureBindings`).
 * Provide {@link ExportDatabaseHttp}.
 *
 * ### Calling ExportDatabase
 * **Example:** ExportDatabase from a Function
 * ```typescript
 * // init
 * const exportDatabase = yield* Azure.Sql.ExportDatabase(database);
 *
 * // runtime
 * yield* exportDatabase({
 *   storageUri: "https://backups.blob.core.windows.net/bacpac/orders.bacpac",
 *   storageKeyType: "StorageAccessKey",
 *   storageKey: Redacted.value(storageKey),
 *   administratorLogin: "sqladmin",
 *   administratorLoginPassword: password,
 * });
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const exportDatabase = yield* Azure.Sql.ExportDatabase(database);
 *   // ...
 * }).pipe(Effect.provide(Azure.Sql.ExportDatabaseHttp));
 * ```
 *
 * @binding
 * @category Sql
 */
export interface ExportDatabase extends Binding.Service<
  ExportDatabase,
  "Azure.Sql.ExportDatabase",
  (
    database: Database,
  ) => Effect.Effect<
    (
      request: ExportDatabaseRequest,
    ) => Effect.Effect<sql.ExportDatabaseResponse, sql.ExportDatabaseError, RuntimeContext>
  >
> {}

export const ExportDatabase = Binding.Service<ExportDatabase>("Azure.Sql.ExportDatabase");
