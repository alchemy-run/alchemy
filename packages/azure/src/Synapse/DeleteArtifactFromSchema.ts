import type * as syms from "@distilled.cloud/azure/synapse-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workspace } from "./Workspace.ts";

/**
 * `DeleteArtifactFromSchema` request without `endpoint`, which the bound
 * workspace (its development endpoint) supplies.
 */
export interface DeleteArtifactFromSchemaRequest extends Omit<
  syms.DeleteArtifactFromSchemaRequest,
  "endpoint"
> {}

/**
 * Delete an artifact of a lake database schema.
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
 * Provide {@link DeleteArtifactFromSchemaHttp}.
 *
 * ### Calling DeleteArtifactFromSchema
 * **Example:** DeleteArtifactFromSchema from a Function
 * ```typescript
 * // init
 * const workspace = yield* Azure.Synapse.Workspace("lake", { defaultDataLakeStorage, sqlAdministratorLogin, sqlAdministratorLoginPassword });
 * const deleteArtifactFromSchema = yield* Azure.Synapse.DeleteArtifactFromSchema(workspace);
 *
 * // runtime
 * const result = yield* deleteArtifactFromSchema({ databaseName: "sales", schemaName: "dbo", artifactType: "TABLE", artifactName: "orders" });
 *
 * // layer
 * Effect.provide(Azure.Synapse.DeleteArtifactFromSchemaHttp)
 * ```
 *
 * @binding
 * @category Synapse
 */
export interface DeleteArtifactFromSchema extends Binding.Service<
  DeleteArtifactFromSchema,
  "Azure.Synapse.DeleteArtifactFromSchema",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: DeleteArtifactFromSchemaRequest,
    ) => Effect.Effect<
      syms.DeleteArtifactFromSchemaResponse,
      syms.DeleteArtifactFromSchemaError,
      RuntimeContext
    >
  >
> {}

export const DeleteArtifactFromSchema = Binding.Service<DeleteArtifactFromSchema>(
  "Azure.Synapse.DeleteArtifactFromSchema",
);
