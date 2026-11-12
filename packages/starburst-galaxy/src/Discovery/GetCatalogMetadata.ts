import type * as discovery from "@distilled.cloud/starburst-galaxy/discovery";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { AnyCatalog } from "../Catalog/AnyCatalog.ts";

/**
 * Read the bound catalog's metadata as Galaxy's catalog explorer shows
 * it: description, owner, contacts and tags.
 *
 * The host calls Galaxy as the deploying profile's API client: Galaxy
 * can't mint a key per host or trust a host's identity (see
 * `StarburstGalaxyBindings`), so the client's role bounds what the host
 * may do.
 *
 * ### Calling it from a Worker
 * **Example:** GetCatalogMetadata
 * ```typescript
 * const shop = StarburstGalaxy.Catalog.PostgresqlCatalog.lookup({ name: "shop" });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const getCatalogMetadata = yield* StarburstGalaxy.Discovery.GetCatalogMetadata(shop);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const metadata = yield* getCatalogMetadata();
 *         return yield* HttpServerResponse.json(metadata.contacts);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(StarburstGalaxy.Discovery.GetCatalogMetadataHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Discovery
 */
export interface GetCatalogMetadata extends Binding.Service<
  GetCatalogMetadata,
  "StarburstGalaxy.Discovery.GetCatalogMetadata",
  (
    catalog: AnyCatalog,
  ) => Effect.Effect<
    () => Effect.Effect<
      discovery.CatalogMetadata,
      discovery.GetCatalogMetadataError,
      RuntimeContext
    >
  >
> {}

export const GetCatalogMetadata = Binding.Service<GetCatalogMetadata>(
  "StarburstGalaxy.Discovery.GetCatalogMetadata",
);
