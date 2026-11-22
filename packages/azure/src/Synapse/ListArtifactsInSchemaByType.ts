import type * as syms from "@distilled.cloud/azure/synapse-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workspace } from "./Workspace.ts";

/**
 * `ListArtifactsInSchemaByType` request without `endpoint`, which the bound
 * workspace (its development endpoint) supplies.
 */
export interface ListArtifactsInSchemaByTypeRequest extends Omit<
  syms.ListArtifactsInSchemaByTypeRequest,
  "endpoint"
> {}

/**
 * List the artifacts of one type in a lake database schema.
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
 * Provide {@link ListArtifactsInSchemaByTypeHttp}.
 *
 * ### Calling ListArtifactsInSchemaByType
 * **Example:** ListArtifactsInSchemaByType from a Function
 * ```typescript
 * // init
 * const workspace = yield* Azure.Synapse.Workspace("lake", { defaultDataLakeStorage, sqlAdministratorLogin, sqlAdministratorLoginPassword });
 * const listArtifactsInSchemaByType = yield* Azure.Synapse.ListArtifactsInSchemaByType(workspace);
 *
 * // runtime
 * const result = yield* listArtifactsInSchemaByType({ databaseName: "sales", schemaName: "dbo", artifactType: "TABLE" });
 *
 * // layer
 * Effect.provide(Azure.Synapse.ListArtifactsInSchemaByTypeHttp)
 * ```
 *
 * @binding
 * @category Synapse
 */
export interface ListArtifactsInSchemaByType extends Binding.Service<
  ListArtifactsInSchemaByType,
  "Azure.Synapse.ListArtifactsInSchemaByType",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: ListArtifactsInSchemaByTypeRequest,
    ) => Effect.Effect<
      syms.QueryArtifactsResponse,
      syms.ListArtifactsInSchemaByTypeError,
      RuntimeContext
    >
  >
> {}

export const ListArtifactsInSchemaByType = Binding.Service<ListArtifactsInSchemaByType>(
  "Azure.Synapse.ListArtifactsInSchemaByType",
);
