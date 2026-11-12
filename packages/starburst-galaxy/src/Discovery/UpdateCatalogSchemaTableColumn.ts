import type * as discovery from "@distilled.cloud/starburst-galaxy/discovery";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { AnyCatalog } from "../Catalog/AnyCatalog.ts";

/** What `updateCatalogSchemaTableColumn` takes. */
export interface UpdateCatalogSchemaTableColumnRequest {
  /** Schema name. */
  readonly schemaName: string;
  /** Table name. */
  readonly tableName: string;
  /** Column name. */
  readonly columnName: string;
  /** The column's new description. */
  readonly description: string;
}

/**
 * Set the description of one column of a table of the bound catalog, e.g.
 * from a job that documents the data it loads. A `TableMetadata` that
 * declares the same column sets it back on its next deploy.
 *
 * The host calls Galaxy as the deploying profile's API client: Galaxy
 * can't mint a key per host or trust a host's identity (see
 * `StarburstGalaxyBindings`), so the client's role bounds what the host
 * may do.
 *
 * ### Calling it from a Worker
 * **Example:** UpdateCatalogSchemaTableColumn
 * ```typescript
 * const shop = StarburstGalaxy.Catalog.PostgresqlCatalog.lookup({ name: "shop" });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const updateCatalogSchemaTableColumn = yield* StarburstGalaxy.Discovery.UpdateCatalogSchemaTableColumn(shop);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const column = yield* updateCatalogSchemaTableColumn({ schemaName: "sales", tableName: "orders", columnName: "amount", description: "Total in USD" });
 *         return yield* HttpServerResponse.json(column.description);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(StarburstGalaxy.Discovery.UpdateCatalogSchemaTableColumnHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Discovery
 */
export interface UpdateCatalogSchemaTableColumn extends Binding.Service<
  UpdateCatalogSchemaTableColumn,
  "StarburstGalaxy.Discovery.UpdateCatalogSchemaTableColumn",
  (
    catalog: AnyCatalog,
  ) => Effect.Effect<
    (
      request: UpdateCatalogSchemaTableColumnRequest,
    ) => Effect.Effect<
      discovery.Column,
      discovery.UpdateCatalogSchemaTableColumnError,
      RuntimeContext
    >
  >
> {}

export const UpdateCatalogSchemaTableColumn = Binding.Service<UpdateCatalogSchemaTableColumn>(
  "StarburstGalaxy.Discovery.UpdateCatalogSchemaTableColumn",
);
