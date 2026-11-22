import type * as syms from "@distilled.cloud/azure/synapse-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workspace } from "./Workspace.ts";

/**
 * `PutArtifactInSchema` request without `endpoint`, which the bound workspace
 * (its development endpoint) supplies.
 */
export interface PutArtifactInSchemaRequest extends Omit<
  syms.PutArtifactInSchemaRequest,
  "endpoint"
> {}

/**
 * Create or update an artifact in a lake database schema.
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
 * Provide {@link PutArtifactInSchemaHttp}.
 *
 * ### Calling PutArtifactInSchema
 * **Example:** PutArtifactInSchema from a Function
 * ```typescript
 * // init
 * const workspace = yield* Azure.Synapse.Workspace("lake", { defaultDataLakeStorage, sqlAdministratorLogin, sqlAdministratorLoginPassword });
 * const putArtifactInSchema = yield* Azure.Synapse.PutArtifactInSchema(workspace);
 *
 * // runtime
 * const result = yield* putArtifactInSchema({ databaseName: "sales", schemaName: "dbo", artifactType: "TABLE", artifactName: "orders", name: "orders", type: "TABLE", properties });
 *
 * // layer
 * Effect.provide(Azure.Synapse.PutArtifactInSchemaHttp)
 * ```
 *
 * @binding
 * @category Synapse
 */
export interface PutArtifactInSchema extends Binding.Service<
  PutArtifactInSchema,
  "Azure.Synapse.PutArtifactInSchema",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: PutArtifactInSchemaRequest,
    ) => Effect.Effect<syms.SyMSAPIDDLResponse, syms.PutArtifactInSchemaError, RuntimeContext>
  >
> {}

export const PutArtifactInSchema = Binding.Service<PutArtifactInSchema>(
  "Azure.Synapse.PutArtifactInSchema",
);
