import type * as syms from "@distilled.cloud/azure/synapse-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workspace } from "./Workspace.ts";

/**
 * `ListPartitionInfosForSchemaAndTable` request without `endpoint`, which the
 * bound workspace (its development endpoint) supplies.
 */
export interface ListPartitionInfosForSchemaAndTableRequest extends Omit<
  syms.ListPartitionInfosForSchemaAndTableRequest,
  "endpoint"
> {}

/**
 * List the partitions of a table in a lake database schema.
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
 * Provide {@link ListPartitionInfosForSchemaAndTableHttp}.
 *
 * ### Calling ListPartitionInfosForSchemaAndTable
 * **Example:** ListPartitionInfosForSchemaAndTable from a Function
 * ```typescript
 * // init
 * const workspace = yield* Azure.Synapse.Workspace("lake", { defaultDataLakeStorage, sqlAdministratorLogin, sqlAdministratorLoginPassword });
 * const listPartitionInfosForSchemaAndTable = yield* Azure.Synapse.ListPartitionInfosForSchemaAndTable(workspace);
 *
 * // runtime
 * const result = yield* listPartitionInfosForSchemaAndTable({ databaseName: "sales", schemaName: "dbo", tableName: "orders" });
 *
 * // layer
 * Effect.provide(Azure.Synapse.ListPartitionInfosForSchemaAndTableHttp)
 * ```
 *
 * @binding
 * @category Synapse
 */
export interface ListPartitionInfosForSchemaAndTable extends Binding.Service<
  ListPartitionInfosForSchemaAndTable,
  "Azure.Synapse.ListPartitionInfosForSchemaAndTable",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: ListPartitionInfosForSchemaAndTableRequest,
    ) => Effect.Effect<
      syms.QueryArtifactsResponse,
      syms.ListPartitionInfosForSchemaAndTableError,
      RuntimeContext
    >
  >
> {}

export const ListPartitionInfosForSchemaAndTable =
  Binding.Service<ListPartitionInfosForSchemaAndTable>(
    "Azure.Synapse.ListPartitionInfosForSchemaAndTable",
  );
