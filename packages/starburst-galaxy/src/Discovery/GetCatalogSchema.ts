import type * as discovery from "@distilled.cloud/starburst-galaxy/discovery";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { AnyCatalog } from "../Catalog/AnyCatalog.ts";

/** What `getCatalogSchema` takes. */
export interface GetCatalogSchemaRequest {
  /** Schema name. */
  readonly schemaName: string;
}

/**
 * Read one schema of the bound catalog: description, owner, contacts,
 * links and tags.
 *
 * The host calls Galaxy as the deploying profile's API client: Galaxy
 * can't mint a key per host or trust a host's identity (see
 * `StarburstGalaxyBindings`), so the client's role bounds what the host
 * may do.
 *
 * ### Calling it from a Worker
 * **Example:** GetCatalogSchema
 * ```typescript
 * const shop = StarburstGalaxy.Catalog.PostgresqlCatalog.lookup({ name: "shop" });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const getCatalogSchema = yield* StarburstGalaxy.Discovery.GetCatalogSchema(shop);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const schema = yield* getCatalogSchema({ schemaName: "sales" });
 *         return yield* HttpServerResponse.json(schema.description);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(StarburstGalaxy.Discovery.GetCatalogSchemaHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Discovery
 */
export interface GetCatalogSchema extends Binding.Service<
  GetCatalogSchema,
  "StarburstGalaxy.Discovery.GetCatalogSchema",
  (
    catalog: AnyCatalog,
  ) => Effect.Effect<
    (
      request: GetCatalogSchemaRequest,
    ) => Effect.Effect<discovery.Schema, discovery.GetCatalogSchemaError, RuntimeContext>
  >
> {}

export const GetCatalogSchema = Binding.Service<GetCatalogSchema>(
  "StarburstGalaxy.Discovery.GetCatalogSchema",
);
