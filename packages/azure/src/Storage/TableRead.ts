import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Table } from "./Table.ts";
import type {
  QueryTableEntitiesOptions,
  QueryTableEntitiesResult,
  TableEntityError,
  TableEntityRecord,
} from "./TableTypes.ts";

/** Read-only client for one Azure Table storage table. */
export interface ReadTableClient {
  /** Read one entity; `undefined` when it does not exist. */
  get(
    partitionKey: string,
    rowKey: string,
  ): Effect.Effect<TableEntityRecord | undefined, TableEntityError, RuntimeContext>;
  /** Read one page of entities, optionally filtered. */
  query(
    options?: QueryTableEntitiesOptions,
  ): Effect.Effect<QueryTableEntitiesResult, TableEntityError, RuntimeContext>;
}

/**
 * Read access to an Azure Table storage table from any host.
 *
 * Binding assigns **Storage Table Data Reader** on the table only (data
 * action `tables/entities/read`, exactly what `get` and `query` call). On a
 * host with a managed identity (an Azure Function, Function App, Web App,
 * Container App, container group, VM, or AKS workload identity) the role
 * goes to that identity. On any other host (a Cloudflare Worker, an AWS
 * Lambda) Alchemy creates an Entra service principal for the host, assigns
 * the role to it, and binds its client secret into the host's env (see
 * `AzureBindings`). Provide {@link TableReadHttp}.
 *
 * ### Reading Entities
 * **Example:** Read an entity
 * ```typescript
 * // init
 * const users = yield* Azure.Storage.TableRead(table);
 *
 * // runtime
 * const user = yield* users.get("users", userId);
 * const name = user?.name;
 * // …provided with Effect.provide(Azure.Storage.TableReadHttp)
 * ```
 *
 * **Example:** Page through a partition
 * ```typescript
 * let continuation: Azure.Storage.TableQueryContinuation | undefined;
 * do {
 *   const page = yield* users.query({ filter: "PartitionKey eq 'users'", continuation });
 *   for (const user of page.entities) yield* Effect.log(user.RowKey);
 *   continuation = page.continuation;
 * } while (continuation);
 * ```
 *
 * @binding
 * @category Storage
 */
export interface TableRead extends Binding.Service<
  TableRead,
  "Azure.Storage.TableRead",
  (table: Table) => Effect.Effect<ReadTableClient>
> {}

export const TableRead = Binding.Service<TableRead>("Azure.Storage.TableRead");
