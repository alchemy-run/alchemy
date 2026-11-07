import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ReadTableClient } from "./ReadTable.ts";
import type { Table } from "./Table.ts";
import { makeBigQueryTableBinding, readWriteTableIam } from "./TableHttp.ts";
import type { WriteTableClient } from "./WriteTable.ts";

export interface ReadWriteTableClient extends ReadTableClient, WriteTableClient {}

/**
 * Read and write access to a BigQuery {@link Table}. Grants
 * `roles/bigquery.dataEditor` on the table and `roles/bigquery.jobUser` on
 * the project (job creation is project-only).
 *
 * ### Reading and writing
 * **Example:** Insert then aggregate
 * ```typescript
 * const events = yield* GCP.BigQuery.ReadWriteTable(table);
 * const tableId = yield* table.tableId;
 * return Effect.gen(function* () {
 *   yield* events.insert([{ id: "a", score: 3 }]);
 *   const [total] = yield* events.query(
 *     `SELECT SUM(score) AS total FROM \`${yield* tableId}\``,
 *   );
 * });
 * // …provided with Effect.provide(GCP.BigQuery.ReadWriteTableHttp)
 * ```
 *
 * @binding
 * @category BigQuery
 */
export interface ReadWriteTable extends Binding.Service<
  ReadWriteTable,
  "GCP.BigQuery.ReadWriteTable",
  (table: Table) => Effect.Effect<ReadWriteTableClient>
> {}

export const ReadWriteTable = Binding.Service<ReadWriteTable>("GCP.BigQuery.ReadWriteTable");

/**
 * HTTP implementation of {@link ReadWriteTable} over the BigQuery REST API.
 *
 * @layer
 * @provides GCP.BigQuery.ReadWriteTable
 * @category BigQuery
 */
export const ReadWriteTableHttp = Layer.effect(
  ReadWriteTable,
  makeBigQueryTableBinding({
    tag: "GCP.BigQuery.ReadWriteTable",
    iam: readWriteTableIam,
    makeClient: (helpers, table) => ({
      ...helpers.makeRead(table),
      ...helpers.makeWrite(table),
    }),
  }),
);
