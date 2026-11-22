import type * as syms from "@distilled.cloud/azure/synapse-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workspace } from "./Workspace.ts";

/**
 * `ListPartitionInfosForTable` request without `endpoint`, which the bound
 * workspace (its development endpoint) supplies.
 */
export interface ListPartitionInfosForTableRequest extends Omit<
  syms.ListPartitionInfosForTableRequest,
  "endpoint"
> {}

/**
 * List the partitions of a lake database table.
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
 * Provide {@link ListPartitionInfosForTableHttp}.
 *
 * ### Calling ListPartitionInfosForTable
 * **Example:** ListPartitionInfosForTable from a Function
 * ```typescript
 * // init
 * const workspace = yield* Azure.Synapse.Workspace("lake", { defaultDataLakeStorage, sqlAdministratorLogin, sqlAdministratorLoginPassword });
 * const listPartitionInfosForTable = yield* Azure.Synapse.ListPartitionInfosForTable(workspace);
 *
 * // runtime
 * const result = yield* listPartitionInfosForTable({ databaseName: "sales", tableName: "orders" });
 *
 * // layer
 * Effect.provide(Azure.Synapse.ListPartitionInfosForTableHttp)
 * ```
 *
 * @binding
 * @category Synapse
 */
export interface ListPartitionInfosForTable extends Binding.Service<
  ListPartitionInfosForTable,
  "Azure.Synapse.ListPartitionInfosForTable",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: ListPartitionInfosForTableRequest,
    ) => Effect.Effect<
      syms.QueryArtifactsResponse,
      syms.ListPartitionInfosForTableError,
      RuntimeContext
    >
  >
> {}

export const ListPartitionInfosForTable = Binding.Service<ListPartitionInfosForTable>(
  "Azure.Synapse.ListPartitionInfosForTable",
);
