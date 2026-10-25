import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { ReadWriteTableClient } from "../Storage/TableReadWrite.ts";
import type { Table } from "./Table.ts";

/**
 * Read and write access to an Azure Cosmos DB for Table table from any host.
 *
 * Binding assigns a custom Cosmos DB data role with only `readMetadata`,
 * `tables/containers/executeQuery`, the `tables/containers/entities`
 * `read`, `create`, `upsert`, `replace`, and `delete` actions, and
 * `tables/containers/executeStoredProcedure` (for merges) on the table only
 * (the built-in Data Contributor also manages tables).
 * Cosmos DB data roles are not Azure RBAC roles: Alchemy creates an
 * `Azure.CosmosDB.TableRoleAssignment` for the host's principal — its
 * managed identity on an Azure Function, Function App, Web App, Container
 * App, container group, or VM; on any other host (a Cloudflare Worker, an
 * AWS Lambda) the Entra service principal Alchemy creates for it (see
 * `AzureBindings`). A custom role is one
 * `Azure.CosmosDB.TableRoleDefinition` per table and binding kind,
 * assignable only on that table.
 * Provide {@link TableReadWriteHttp}. The client is the same as
 * `Azure.Storage.TableReadWrite`'s.
 *
 * ### Reading and Writing Entities
 * **Example:** Count visits
 * ```typescript
 * // init
 * const counters = yield* Azure.CosmosDB.TableReadWrite(table);
 *
 * // runtime
 * const current = yield* counters.get("counters", "visits");
 * const n = typeof current?.n === "number" ? current.n + 1 : 1;
 * yield* counters.upsert({ PartitionKey: "counters", RowKey: "visits", n });
 * ```
 *
 * @binding
 * @category CosmosDB
 */
export interface TableReadWrite extends Binding.Service<
  TableReadWrite,
  "Azure.CosmosDB.TableReadWrite",
  (table: Table) => Effect.Effect<ReadWriteTableClient>
> {}

export const TableReadWrite = Binding.Service<TableReadWrite>("Azure.CosmosDB.TableReadWrite");
