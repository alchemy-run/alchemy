import type * as discovery from "@distilled.cloud/starburst-galaxy/discovery";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { AnyCatalog } from "../Catalog/AnyCatalog.ts";

/**
 * List the schemas of the bound catalog, with their descriptions, owners,
 * contacts, links and tags (every page).
 *
 * The host calls Galaxy as the deploying profile's API client: Galaxy
 * can't mint a key per host or trust a host's identity (see
 * `StarburstGalaxyBindings`), so the client's role bounds what the host
 * may do.
 *
 * ### Calling it from a Worker
 * **Example:** ListCatalogSchemas
 * ```typescript
 * const shop = StarburstGalaxy.Catalog.PostgresqlCatalog.lookup({ name: "shop" });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const listCatalogSchemas = yield* StarburstGalaxy.Discovery.ListCatalogSchemas(shop);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const schemas = yield* listCatalogSchemas();
 *         return yield* HttpServerResponse.json(schemas.map((s) => s.schemaId));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(StarburstGalaxy.Discovery.ListCatalogSchemasHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Discovery
 */
export interface ListCatalogSchemas extends Binding.Service<
  ListCatalogSchemas,
  "StarburstGalaxy.Discovery.ListCatalogSchemas",
  (
    catalog: AnyCatalog,
  ) => Effect.Effect<
    () => Effect.Effect<
      ReadonlyArray<discovery.Schema>,
      discovery.ListCatalogSchemasError,
      RuntimeContext
    >
  >
> {}

export const ListCatalogSchemas = Binding.Service<ListCatalogSchemas>(
  "StarburstGalaxy.Discovery.ListCatalogSchemas",
);
