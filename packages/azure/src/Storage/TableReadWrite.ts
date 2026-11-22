import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Table } from "./Table.ts";
import type { ReadTableClient } from "./TableRead.ts";
import type { WriteTableClient } from "./TableWrite.ts";

/** Read + write client for one Azure Table storage table. */
export interface ReadWriteTableClient extends ReadTableClient, WriteTableClient {}

/**
 * Read and write access to an Azure Table storage table from any host.
 *
 * Binding assigns a custom role on the table only with the data actions
 * `tables/entities/read`, `tables/entities/add/action`,
 * `tables/entities/update/action`, and `tables/entities/delete` (the
 * built-in Storage Table Data Contributor also creates and deletes
 * tables). The role is one `Azure.Authorization.RoleDefinition` per stack,
 * `AzureStorageTableReadWriteRole`, shared by every host. On a host with a
 * managed identity (an Azure Function, Function App, Web App, Container
 * App, container group, VM, or AKS workload identity) the role goes to
 * that identity. On any other host (a Cloudflare Worker, an AWS Lambda)
 * Alchemy creates an Entra service principal for the host, assigns the
 * role to it, and binds its client secret into the host's env (see
 * `AzureBindings`). Provide {@link TableReadWriteHttp}.
 *
 * ### Reading and Writing Entities
 * **Example:** Count visits
 * ```typescript
 * // init
 * const counters = yield* Azure.Storage.TableReadWrite(table);
 *
 * // runtime
 * const current = yield* counters.get("counters", "visits");
 * const n = typeof current?.n === "number" ? current.n + 1 : 1;
 * yield* counters.upsert({ PartitionKey: "counters", RowKey: "visits", n });
 * // …provided with Effect.provide(Azure.Storage.TableReadWriteHttp)
 * ```
 *
 * @binding
 * @category Storage
 */
export interface TableReadWrite extends Binding.Service<
  TableReadWrite,
  "Azure.Storage.TableReadWrite",
  (table: Table) => Effect.Effect<ReadWriteTableClient>
> {}

export const TableReadWrite = Binding.Service<TableReadWrite>("Azure.Storage.TableReadWrite");
