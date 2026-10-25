import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Table } from "./Table.ts";
import type { TableEntity, TableEntityError, UpdateTableEntityOptions } from "./TableTypes.ts";

/** The ETag of a written entity. */
export interface TableWriteResult {
  etag: string | undefined;
}

/** Write-only client for one Azure Table storage table. */
export interface WriteTableClient {
  /** Insert a new entity; fails with `TableEntityAlreadyExists` if one has the same keys. */
  insert(entity: TableEntity): Effect.Effect<TableWriteResult, TableEntityError, RuntimeContext>;
  /**
   * Insert the entity, or replace (`mode: "replace"`, the default) or merge
   * (`mode: "merge"`) the existing one.
   */
  upsert(
    entity: TableEntity,
    options?: { mode?: "replace" | "merge" },
  ): Effect.Effect<TableWriteResult, TableEntityError, RuntimeContext>;
  /**
   * Replace or merge an existing entity; fails with `TableEntityNotFound`
   * when it does not exist and `TableEntityConditionNotMet` when `etag` is
   * stale.
   */
  update(
    entity: TableEntity,
    options?: UpdateTableEntityOptions & { mode?: "replace" | "merge" },
  ): Effect.Effect<TableWriteResult, TableEntityError, RuntimeContext>;
  /**
   * Delete an entity. Without `etag` a missing entity succeeds; with one, a
   * stale `etag` fails with `TableEntityConditionNotMet`.
   */
  delete(
    partitionKey: string,
    rowKey: string,
    options?: UpdateTableEntityOptions,
  ): Effect.Effect<void, TableEntityError, RuntimeContext>;
}

/**
 * Write access to an Azure Table storage table from any host: insert,
 * upsert, update, and delete entities, without reading them.
 *
 * Binding assigns a custom role on the table only with the data actions
 * `tables/entities/add/action`, `tables/entities/update/action`, and
 * `tables/entities/delete` (the built-in Storage Table Data Contributor
 * also reads). The role is one `Azure.Authorization.RoleDefinition` per
 * stack, `AzureStorageTableWriteRole`, shared by every host. On a host with
 * a managed identity (an Azure Function, Function App, Web App, Container
 * App, container group, VM, or AKS workload identity) the role goes to
 * that identity. On any other host (a Cloudflare Worker, an AWS Lambda)
 * Alchemy creates an Entra service principal for the host, assigns the
 * role to it, and binds its client secret into the host's env (see
 * `AzureBindings`). Provide {@link TableWriteHttp}.
 *
 * ### Writing Entities
 * **Example:** Record an event
 * ```typescript
 * // init
 * const events = yield* Azure.Storage.TableWrite(table);
 *
 * // runtime
 * yield* events.insert({ PartitionKey: "events", RowKey: eventId, kind: "signup" });
 * ```
 *
 * **Example:** Optimistic concurrency
 * ```typescript
 * const { etag } = yield* events.upsert({ PartitionKey: "counters", RowKey: "hits", n: 1 });
 * yield* events.update({ PartitionKey: "counters", RowKey: "hits", n: 2 }, { etag });
 * ```
 *
 * @binding
 * @category Storage
 */
export interface TableWrite extends Binding.Service<
  TableWrite,
  "Azure.Storage.TableWrite",
  (table: Table) => Effect.Effect<WriteTableClient>
> {}

export const TableWrite = Binding.Service<TableWrite>("Azure.Storage.TableWrite");
