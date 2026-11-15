import type * as discovery from "@distilled.cloud/starburst-galaxy/discovery";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { AnyCatalog } from "../Catalog/AnyCatalog.ts";

/** What `listCatalogSchemaTables` takes. */
export interface ListCatalogSchemaTablesRequest {
  /** Schema name. */
  readonly schemaName: string;
}

/**
 * List the tables and views of one schema of the bound catalog (every
 * page).
 *
 * The host calls Galaxy as the deploying profile's API client: Galaxy
 * can't mint a key per host or trust a host's identity (see
 * `StarburstGalaxyBindings`), so the client's role bounds what the host
 * may do.
 *
 * ### Calling it from a Worker
 * **Example:** ListCatalogSchemaTables
 * ```typescript
 * const shop = StarburstGalaxy.Catalog.PostgresqlCatalog.lookup({ name: "shop" });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const listCatalogSchemaTables = yield* StarburstGalaxy.Discovery.ListCatalogSchemaTables(shop);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const tables = yield* listCatalogSchemaTables({ schemaName: "sales" });
 *         return yield* HttpServerResponse.json(tables.map((t) => t.tableId));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(StarburstGalaxy.Discovery.ListCatalogSchemaTablesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Discovery
 */
export interface ListCatalogSchemaTables extends Binding.Service<
  ListCatalogSchemaTables,
  "StarburstGalaxy.Discovery.ListCatalogSchemaTables",
  (
    catalog: AnyCatalog,
  ) => Effect.Effect<
    (
      request: ListCatalogSchemaTablesRequest,
    ) => Effect.Effect<
      ReadonlyArray<discovery.Table>,
      discovery.ListCatalogSchemaTablesError,
      RuntimeContext
    >
  >
> {}

export const ListCatalogSchemaTables = Binding.Service<ListCatalogSchemaTables>(
  "StarburstGalaxy.Discovery.ListCatalogSchemaTables",
);
