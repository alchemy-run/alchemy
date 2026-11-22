import type * as syms from "@distilled.cloud/azure/synapse-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workspace } from "./Workspace.ts";

/**
 * `DeleteArtifactForDB` request without `endpoint`, which the bound workspace
 * (its development endpoint) supplies.
 */
export interface DeleteArtifactForDBRequest extends Omit<
  syms.DeleteArtifactForDBRequest,
  "endpoint"
> {}

/**
 * Delete an artifact of a lake database.
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
 * Provide {@link DeleteArtifactForDBHttp}.
 *
 * ### Calling DeleteArtifactForDB
 * **Example:** DeleteArtifactForDB from a Function
 * ```typescript
 * // init
 * const workspace = yield* Azure.Synapse.Workspace("lake", { defaultDataLakeStorage, sqlAdministratorLogin, sqlAdministratorLoginPassword });
 * const deleteArtifactForDB = yield* Azure.Synapse.DeleteArtifactForDB(workspace);
 *
 * // runtime
 * const result = yield* deleteArtifactForDB({ databaseName: "sales", artifactType: "TABLE", artifactName: "orders" });
 *
 * // layer
 * Effect.provide(Azure.Synapse.DeleteArtifactForDBHttp)
 * ```
 *
 * @binding
 * @category Synapse
 */
export interface DeleteArtifactForDB extends Binding.Service<
  DeleteArtifactForDB,
  "Azure.Synapse.DeleteArtifactForDB",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: DeleteArtifactForDBRequest,
    ) => Effect.Effect<
      syms.DeleteArtifactForDBResponse,
      syms.DeleteArtifactForDBError,
      RuntimeContext
    >
  >
> {}

export const DeleteArtifactForDB = Binding.Service<DeleteArtifactForDB>(
  "Azure.Synapse.DeleteArtifactForDB",
);
