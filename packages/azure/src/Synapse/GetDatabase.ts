import type * as syms from "@distilled.cloud/azure/synapse-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workspace } from "./Workspace.ts";

/**
 * `GetDatabase` request without `endpoint`, which the bound workspace (its
 * development endpoint) supplies.
 */
export interface GetDatabaseRequest extends Omit<syms.GetDatabaseRequest, "endpoint"> {}

/**
 * Read a lake database.
 *
 * Binding assigns the Synapse RBAC role **Synapse Artifact User** to the host's
 * principal on the bound workspace only (an
 * `Azure.Synapse.WorkspaceRoleAssignment`): the smallest role SyMS accepts for
 * reads (**Synapse User** gets 403). Synapse RBAC has no custom roles. The
 * workspace firewall must admit the host (Flex Consumption and Workers use
 * shared outbound IPs).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetDatabaseHttp}.
 *
 * ### Calling GetDatabase
 * **Example:** GetDatabase from a Function
 * ```typescript
 * // init
 * const workspace = yield* Azure.Synapse.Workspace("lake", { defaultDataLakeStorage, sqlAdministratorLogin, sqlAdministratorLoginPassword });
 * const getDatabase = yield* Azure.Synapse.GetDatabase(workspace);
 *
 * // runtime
 * const result = yield* getDatabase({ databaseName: "sales" });
 *
 * // layer
 * Effect.provide(Azure.Synapse.GetDatabaseHttp)
 * ```
 *
 * @binding
 * @category Synapse
 */
export interface GetDatabase extends Binding.Service<
  GetDatabase,
  "Azure.Synapse.GetDatabase",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: GetDatabaseRequest,
    ) => Effect.Effect<syms.GetDatabaseResponse, syms.GetDatabaseError, RuntimeContext>
  >
> {}

export const GetDatabase = Binding.Service<GetDatabase>("Azure.Synapse.GetDatabase");
