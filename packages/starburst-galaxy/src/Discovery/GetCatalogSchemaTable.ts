import type * as discovery from "@distilled.cloud/starburst-galaxy/discovery";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { AnyCatalog } from "../Catalog/AnyCatalog.ts";

/** What `getCatalogSchemaTable` takes. */
export interface GetCatalogSchemaTableRequest {
  /** Schema name. */
  readonly schemaName: string;
  /** Table name. */
  readonly tableName: string;
}

/**
 * Read one table of the bound catalog: type, description, owner, contacts
 * and tags.
 *
 * The host calls Galaxy as the deploying profile's API client: Galaxy
 * can't mint a key per host or trust a host's identity (see
 * `StarburstGalaxyBindings`), so the client's role bounds what the host
 * may do.
 *
 * ### Calling it from a Worker
 * **Example:** GetCatalogSchemaTable
 * ```typescript
 * const shop = StarburstGalaxy.Catalog.PostgresqlCatalog.lookup({ name: "shop" });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const getCatalogSchemaTable = yield* StarburstGalaxy.Discovery.GetCatalogSchemaTable(shop);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const table = yield* getCatalogSchemaTable({ schemaName: "sales", tableName: "orders" });
 *         return yield* HttpServerResponse.json(table.description);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(StarburstGalaxy.Discovery.GetCatalogSchemaTableHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Discovery
 */
export interface GetCatalogSchemaTable extends Binding.Service<
  GetCatalogSchemaTable,
  "StarburstGalaxy.Discovery.GetCatalogSchemaTable",
  (
    catalog: AnyCatalog,
  ) => Effect.Effect<
    (
      request: GetCatalogSchemaTableRequest,
    ) => Effect.Effect<discovery.Table, discovery.GetCatalogSchemaTableError, RuntimeContext>
  >
> {}

export const GetCatalogSchemaTable = Binding.Service<GetCatalogSchemaTable>(
  "StarburstGalaxy.Discovery.GetCatalogSchemaTable",
);
