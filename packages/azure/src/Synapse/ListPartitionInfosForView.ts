import type * as syms from "@distilled.cloud/azure/synapse-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workspace } from "./Workspace.ts";

/**
 * `ListPartitionInfosForView` request without `endpoint`, which the bound
 * workspace (its development endpoint) supplies.
 */
export interface ListPartitionInfosForViewRequest extends Omit<
  syms.ListPartitionInfosForViewRequest,
  "endpoint"
> {}

/**
 * List the partitions of a lake database view.
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
 * Provide {@link ListPartitionInfosForViewHttp}.
 *
 * ### Calling ListPartitionInfosForView
 * **Example:** ListPartitionInfosForView from a Function
 * ```typescript
 * // init
 * const workspace = yield* Azure.Synapse.Workspace("lake", { defaultDataLakeStorage, sqlAdministratorLogin, sqlAdministratorLoginPassword });
 * const listPartitionInfosForView = yield* Azure.Synapse.ListPartitionInfosForView(workspace);
 *
 * // runtime
 * const result = yield* listPartitionInfosForView({ databaseName: "sales", viewName: "recent" });
 *
 * // layer
 * Effect.provide(Azure.Synapse.ListPartitionInfosForViewHttp)
 * ```
 *
 * @binding
 * @category Synapse
 */
export interface ListPartitionInfosForView extends Binding.Service<
  ListPartitionInfosForView,
  "Azure.Synapse.ListPartitionInfosForView",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: ListPartitionInfosForViewRequest,
    ) => Effect.Effect<
      syms.QueryArtifactsResponse,
      syms.ListPartitionInfosForViewError,
      RuntimeContext
    >
  >
> {}

export const ListPartitionInfosForView = Binding.Service<ListPartitionInfosForView>(
  "Azure.Synapse.ListPartitionInfosForView",
);
