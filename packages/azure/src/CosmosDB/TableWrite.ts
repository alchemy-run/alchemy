import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { WriteTableClient } from "../Storage/TableWrite.ts";
import type { Table } from "./Table.ts";

/**
 * Write access to an Azure Cosmos DB for Table table from any host:
 * `insert`, `upsert`, `update`, and `delete`, without reading.
 *
 * Binding assigns a custom Cosmos DB data role with only `readMetadata`,
 * the `tables/containers/entities` `create`, `upsert`, `replace`, and
 * `delete` actions, and `tables/containers/executeStoredProcedure` (a
 * `mode: "merge"` write runs as a system stored procedure) on the table
 * only.
 * Cosmos DB data roles are not Azure RBAC roles: Alchemy creates an
 * `Azure.CosmosDB.TableRoleAssignment` for the host's principal — its
 * managed identity on an Azure Function, Function App, Web App, Container
 * App, container group, or VM; on any other host (a Cloudflare Worker, an
 * AWS Lambda) the Entra service principal Alchemy creates for it (see
 * `AzureBindings`). A custom role is one
 * `Azure.CosmosDB.TableRoleDefinition` per table and binding kind,
 * assignable only on that table.
 * Provide {@link TableWriteHttp}. The client is the same as
 * `Azure.Storage.TableWrite`'s.
 *
 * ### Writing Entities
 * **Example:** Record a session
 * ```typescript
 * // init
 * const sessions = yield* Azure.CosmosDB.TableWrite(table);
 *
 * // runtime
 * yield* sessions.upsert({ PartitionKey: "sessions", RowKey: sessionId, user });
 * // …provided with Effect.provide(Azure.CosmosDB.TableWriteHttp)
 * ```
 *
 * @binding
 * @category CosmosDB
 */
export interface TableWrite extends Binding.Service<
  TableWrite,
  "Azure.CosmosDB.TableWrite",
  (table: Table) => Effect.Effect<WriteTableClient>
> {}

export const TableWrite = Binding.Service<TableWrite>("Azure.CosmosDB.TableWrite");
