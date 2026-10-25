import type * as sql from "@distilled.cloud/azure/sql";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Database } from "./Database.ts";

export interface CreateRestorePointRequest extends Omit<
  sql.CreateRestorePointRequest,
  "subscriptionId" | "resourceGroupName" | "serverName" | "databaseName"
> {}

/**
 * Create a labelled restore point of a dedicated SQL pool (formerly SQL Data
 * Warehouse) database (`POST …/databases/{database}/restorePoints`). Other
 * editions fail with `FeatureDisabledOnSelectedEdition`.
 *
 * Binding assigns a custom role (`AzureSqlCreateRestorePointRole`, one per
 * stack, shared by every host of this binding) with exactly the action
 * `Microsoft.Sql/servers/databases/restorePoints/action`, on the database
 * only. On a host with a managed identity (an Azure Function, Function App,
 * Web App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link CreateRestorePointHttp}.
 *
 * ### Calling CreateRestorePoint
 * **Example:** CreateRestorePoint from a Function
 * ```typescript
 * // init
 * const createRestorePoint = yield* Azure.Sql.CreateRestorePoint(database);
 *
 * // runtime
 * yield* createRestorePoint({ restorePointLabel: "before-load-2026-10-25" });
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const createRestorePoint = yield* Azure.Sql.CreateRestorePoint(database);
 *   // ...
 * }).pipe(Effect.provide(Azure.Sql.CreateRestorePointHttp));
 * ```
 *
 * @binding
 * @category Sql
 */
export interface CreateRestorePoint extends Binding.Service<
  CreateRestorePoint,
  "Azure.Sql.CreateRestorePoint",
  (
    database: Database,
  ) => Effect.Effect<
    (
      request: CreateRestorePointRequest,
    ) => Effect.Effect<sql.CreateRestorePointResponse, sql.CreateRestorePointError, RuntimeContext>
  >
> {}

export const CreateRestorePoint = Binding.Service<CreateRestorePoint>(
  "Azure.Sql.CreateRestorePoint",
);
