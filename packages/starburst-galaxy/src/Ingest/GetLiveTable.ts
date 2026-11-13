import type * as liveTables from "@distilled.cloud/starburst-galaxy/live_table";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { LiveTable } from "./LiveTable.ts";

/**
 * Read the bound live table: whether ingestion is running, why it
 * stopped, and how many errors and warnings it raised.
 *
 * The host calls Galaxy as the deploying profile's API client: Galaxy
 * can't mint a key per host or trust a host's identity (see
 * `StarburstGalaxyBindings`), so the client's role bounds what the host
 * may do.
 *
 * ### Calling it from a Worker
 * **Example:** GetLiveTable
 * ```typescript
 * const lake = StarburstGalaxy.Catalog.S3Catalog.lookup({ name: "lake" });
 * export const RawEvents = StarburstGalaxy.Ingest.LiveTable("RawEvents", {
 *   catalogId: lake.catalogId,
 *   schemaName: "ingest",
 *   tableName: "raw_events",
 *   typeProperties: {
 *     typeKey: "newFileIngestProperties",
 *     fileIngestSourceId: "is-1234567890",
 *     fileFormat: "Json",
 *     pollingIntervalInMinutes: 5,
 *   },
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const getLiveTable = yield* StarburstGalaxy.Ingest.GetLiveTable(RawEvents);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const table = yield* getLiveTable();
 *         return yield* HttpServerResponse.json(table.liveTableState);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(StarburstGalaxy.Ingest.GetLiveTableHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Ingest
 */
export interface GetLiveTable extends Binding.Service<
  GetLiveTable,
  "StarburstGalaxy.Ingest.GetLiveTable",
  (
    table: LiveTable,
  ) => Effect.Effect<
    () => Effect.Effect<liveTables.LiveTable, liveTables.GetLiveTableError, RuntimeContext>
  >
> {}

export const GetLiveTable = Binding.Service<GetLiveTable>("StarburstGalaxy.Ingest.GetLiveTable");
