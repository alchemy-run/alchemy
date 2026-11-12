import type * as discovery from "@distilled.cloud/starburst-galaxy/discovery";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { AnyCatalog } from "../Catalog/AnyCatalog.ts";

/** What `getCatalogSchemaTableColumn` takes. */
export interface GetCatalogSchemaTableColumnRequest {
  /** Schema name. */
  readonly schemaName: string;
  /** Table name. */
  readonly tableName: string;
  /** Column name. */
  readonly columnName: string;
}

/**
 * Read one column of a table of the bound catalog.
 *
 * The host calls Galaxy as the deploying profile's API client: Galaxy
 * can't mint a key per host or trust a host's identity (see
 * `StarburstGalaxyBindings`), so the client's role bounds what the host
 * may do.
 *
 * ### Calling it from a Worker
 * **Example:** GetCatalogSchemaTableColumn
 * ```typescript
 * const shop = StarburstGalaxy.Catalog.PostgresqlCatalog.lookup({ name: "shop" });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const getCatalogSchemaTableColumn = yield* StarburstGalaxy.Discovery.GetCatalogSchemaTableColumn(shop);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const column = yield* getCatalogSchemaTableColumn({ schemaName: "sales", tableName: "orders", columnName: "amount" });
 *         return yield* HttpServerResponse.json(column.description);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(StarburstGalaxy.Discovery.GetCatalogSchemaTableColumnHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Discovery
 */
export interface GetCatalogSchemaTableColumn extends Binding.Service<
  GetCatalogSchemaTableColumn,
  "StarburstGalaxy.Discovery.GetCatalogSchemaTableColumn",
  (
    catalog: AnyCatalog,
  ) => Effect.Effect<
    (
      request: GetCatalogSchemaTableColumnRequest,
    ) => Effect.Effect<discovery.Column, discovery.GetCatalogSchemaTableColumnError, RuntimeContext>
  >
> {}

export const GetCatalogSchemaTableColumn = Binding.Service<GetCatalogSchemaTableColumn>(
  "StarburstGalaxy.Discovery.GetCatalogSchemaTableColumn",
);
