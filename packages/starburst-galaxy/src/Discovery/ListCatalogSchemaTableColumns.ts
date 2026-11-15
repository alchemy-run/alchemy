import type * as discovery from "@distilled.cloud/starburst-galaxy/discovery";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { AnyCatalog } from "../Catalog/AnyCatalog.ts";

/** What `listCatalogSchemaTableColumns` takes. */
export interface ListCatalogSchemaTableColumnsRequest {
  /** Schema name. */
  readonly schemaName: string;
  /** Table name. */
  readonly tableName: string;
}

/**
 * List the columns of one table of the bound catalog, with their Trino
 * types, nullability, descriptions and tags (every page).
 *
 * The host calls Galaxy as the deploying profile's API client: Galaxy
 * can't mint a key per host or trust a host's identity (see
 * `StarburstGalaxyBindings`), so the client's role bounds what the host
 * may do.
 *
 * ### Calling it from a Worker
 * **Example:** ListCatalogSchemaTableColumns
 * ```typescript
 * const shop = StarburstGalaxy.Catalog.PostgresqlCatalog.lookup({ name: "shop" });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const listCatalogSchemaTableColumns = yield* StarburstGalaxy.Discovery.ListCatalogSchemaTableColumns(shop);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const columns = yield* listCatalogSchemaTableColumns({ schemaName: "sales", tableName: "orders" });
 *         return yield* HttpServerResponse.json(columns.map((c) => [c.columnId, c.dataType]));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(StarburstGalaxy.Discovery.ListCatalogSchemaTableColumnsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Discovery
 */
export interface ListCatalogSchemaTableColumns extends Binding.Service<
  ListCatalogSchemaTableColumns,
  "StarburstGalaxy.Discovery.ListCatalogSchemaTableColumns",
  (
    catalog: AnyCatalog,
  ) => Effect.Effect<
    (
      request: ListCatalogSchemaTableColumnsRequest,
    ) => Effect.Effect<
      ReadonlyArray<discovery.Column>,
      discovery.ListCatalogSchemaTableColumnsError,
      RuntimeContext
    >
  >
> {}

export const ListCatalogSchemaTableColumns = Binding.Service<ListCatalogSchemaTableColumns>(
  "StarburstGalaxy.Discovery.ListCatalogSchemaTableColumns",
);
