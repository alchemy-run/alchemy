import type * as syms from "@distilled.cloud/azure/synapse-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workspace } from "./Workspace.ts";

/**
 * `ListPartitionInfosForSchemaAndView` request without `endpoint`, which the
 * bound workspace (its development endpoint) supplies.
 */
export interface ListPartitionInfosForSchemaAndViewRequest extends Omit<
  syms.ListPartitionInfosForSchemaAndViewRequest,
  "endpoint"
> {}

/**
 * List the partitions of a view in a lake database schema.
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
 * Provide {@link ListPartitionInfosForSchemaAndViewHttp}.
 *
 * ### Calling ListPartitionInfosForSchemaAndView
 * **Example:** ListPartitionInfosForSchemaAndView from a Function
 * ```typescript
 * // init
 * const workspace = yield* Azure.Synapse.Workspace("lake", { defaultDataLakeStorage, sqlAdministratorLogin, sqlAdministratorLoginPassword });
 * const listPartitionInfosForSchemaAndView = yield* Azure.Synapse.ListPartitionInfosForSchemaAndView(workspace);
 *
 * // runtime
 * const result = yield* listPartitionInfosForSchemaAndView({ databaseName: "sales", schemaName: "dbo", viewName: "recent" });
 *
 * // layer
 * Effect.provide(Azure.Synapse.ListPartitionInfosForSchemaAndViewHttp)
 * ```
 *
 * @binding
 * @category Synapse
 */
export interface ListPartitionInfosForSchemaAndView extends Binding.Service<
  ListPartitionInfosForSchemaAndView,
  "Azure.Synapse.ListPartitionInfosForSchemaAndView",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: ListPartitionInfosForSchemaAndViewRequest,
    ) => Effect.Effect<
      syms.QueryArtifactsResponse,
      syms.ListPartitionInfosForSchemaAndViewError,
      RuntimeContext
    >
  >
> {}

export const ListPartitionInfosForSchemaAndView =
  Binding.Service<ListPartitionInfosForSchemaAndView>(
    "Azure.Synapse.ListPartitionInfosForSchemaAndView",
  );
