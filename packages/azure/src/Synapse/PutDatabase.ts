import type * as syms from "@distilled.cloud/azure/synapse-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workspace } from "./Workspace.ts";

/**
 * `PutDatabase` request without `endpoint`, which the bound workspace (its
 * development endpoint) supplies.
 */
export interface PutDatabaseRequest extends Omit<syms.PutDatabaseRequest, "endpoint"> {}

/**
 * Create or update a lake database (`PUT /databases/{databaseName}`).
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
 * Provide {@link PutDatabaseHttp}.
 *
 * ### Calling PutDatabase
 * **Example:** PutDatabase from a Function
 * ```typescript
 * // init
 * const workspace = yield* Azure.Synapse.Workspace("lake", { defaultDataLakeStorage, sqlAdministratorLogin, sqlAdministratorLoginPassword });
 * const putDatabase = yield* Azure.Synapse.PutDatabase(workspace);
 *
 * // runtime
 * const result = yield* putDatabase({ databaseName: "sales", name: "sales", type: "DATABASE", properties });
 *
 * // layer
 * Effect.provide(Azure.Synapse.PutDatabaseHttp)
 * ```
 *
 * @binding
 * @category Synapse
 */
export interface PutDatabase extends Binding.Service<
  PutDatabase,
  "Azure.Synapse.PutDatabase",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: PutDatabaseRequest,
    ) => Effect.Effect<syms.SyMSAPIDDLResponse, syms.PutDatabaseError, RuntimeContext>
  >
> {}

export const PutDatabase = Binding.Service<PutDatabase>("Azure.Synapse.PutDatabase");
