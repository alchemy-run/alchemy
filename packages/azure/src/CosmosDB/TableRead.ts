import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { ReadTableClient } from "../Storage/TableRead.ts";
import type { Table } from "./Table.ts";

/**
 * Read access to an Azure Cosmos DB for Table table from any host: `get` and
 * `query`.
 *
 * Binding assigns a custom Cosmos DB data role with only `readMetadata`,
 * `tables/containers/entities/read`, and `tables/containers/executeQuery` on
 * the table only.
 * Cosmos DB data roles are not Azure RBAC roles: Alchemy creates an
 * `Azure.CosmosDB.TableRoleAssignment` for the host's principal — its
 * managed identity on an Azure Function, Function App, Web App, Container
 * App, container group, or VM; on any other host (a Cloudflare Worker, an
 * AWS Lambda) the Entra service principal Alchemy creates for it (see
 * `AzureBindings`). A custom role is one
 * `Azure.CosmosDB.TableRoleDefinition` per table and binding kind,
 * assignable only on that table.
 * Provide {@link TableReadHttp}. The client is the same as
 * `Azure.Storage.TableRead`'s.
 *
 * ### Reading Entities
 * **Example:** Read a session
 * ```typescript
 * // init
 * const sessions = yield* Azure.CosmosDB.TableRead(table);
 *
 * // runtime
 * const session = yield* sessions.get("sessions", sessionId);
 * // …provided with Effect.provide(Azure.CosmosDB.TableReadHttp)
 * ```
 *
 * @binding
 * @category CosmosDB
 */
export interface TableRead extends Binding.Service<
  TableRead,
  "Azure.CosmosDB.TableRead",
  (table: Table) => Effect.Effect<ReadTableClient>
> {}

export const TableRead = Binding.Service<TableRead>("Azure.CosmosDB.TableRead");
