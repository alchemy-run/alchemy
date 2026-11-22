import type * as syms from "@distilled.cloud/azure/synapse-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workspace } from "./Workspace.ts";

/**
 * `DeleteDatabase` request without `endpoint`, which the bound workspace (its
 * development endpoint) supplies.
 */
export interface DeleteDatabaseRequest extends Omit<syms.DeleteDatabaseRequest, "endpoint"> {}

/**
 * Delete a lake database.
 *
 * Binding assigns the Synapse RBAC role **Synapse Artifact Publisher** to the
 * host's principal on the bound workspace only (an
 * `Azure.Synapse.WorkspaceRoleAssignment`): the smallest role SyMS accepts for
 * writes (**Synapse Artifact User** and **Synapse SQL Administrator** get 403).
 * Synapse RBAC has no custom roles. The workspace firewall must admit the host
 * (Flex Consumption and Workers use shared outbound IPs).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link DeleteDatabaseHttp}.
 *
 * ### Calling DeleteDatabase
 * **Example:** DeleteDatabase from a Function
 * ```typescript
 * // init
 * const workspace = yield* Azure.Synapse.Workspace("lake", { defaultDataLakeStorage, sqlAdministratorLogin, sqlAdministratorLoginPassword });
 * const deleteDatabase = yield* Azure.Synapse.DeleteDatabase(workspace);
 *
 * // runtime
 * const result = yield* deleteDatabase({ databaseName: "sales" });
 *
 * // layer
 * Effect.provide(Azure.Synapse.DeleteDatabaseHttp)
 * ```
 *
 * @binding
 * @category Synapse
 */
export interface DeleteDatabase extends Binding.Service<
  DeleteDatabase,
  "Azure.Synapse.DeleteDatabase",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: DeleteDatabaseRequest,
    ) => Effect.Effect<syms.DeleteDatabaseResponse, syms.DeleteDatabaseError, RuntimeContext>
  >
> {}

export const DeleteDatabase = Binding.Service<DeleteDatabase>("Azure.Synapse.DeleteDatabase");
