import type * as schemaDiscovery from "@distilled.cloud/starburst-galaxy/schema_discovery";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { AnyCatalog } from "../Catalog/AnyCatalog.ts";

/** What `listSchemaDiscoveries` takes. */
export interface ListSchemaDiscoveriesRequest {
  /** Only the latest run per location. */
  readonly latest?: boolean;
}

/**
 * List the schema discovery runs of the bound catalog (every page).
 *
 * The host calls Galaxy as the deploying profile's API client: Galaxy
 * can't mint a key per host or trust a host's identity (see
 * `StarburstGalaxyBindings`), so the client's role bounds what the host
 * may do.
 *
 * ### Calling it from a Worker
 * **Example:** ListSchemaDiscoveries
 * ```typescript
 * const shop = StarburstGalaxy.Catalog.PostgresqlCatalog.lookup({ name: "shop" });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const listSchemaDiscoveries = yield* StarburstGalaxy.SchemaDiscovery.ListSchemaDiscoveries(shop);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const runs = yield* listSchemaDiscoveries({ latest: true });
 *         return yield* HttpServerResponse.json(runs.map((r) => r.status));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(StarburstGalaxy.SchemaDiscovery.ListSchemaDiscoveriesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product SchemaDiscovery
 */
export interface ListSchemaDiscoveries extends Binding.Service<
  ListSchemaDiscoveries,
  "StarburstGalaxy.SchemaDiscovery.ListSchemaDiscoveries",
  (
    catalog: AnyCatalog,
  ) => Effect.Effect<
    (
      request?: ListSchemaDiscoveriesRequest,
    ) => Effect.Effect<
      ReadonlyArray<schemaDiscovery.SchemaDiscovery>,
      schemaDiscovery.ListSchemaDiscoveriesError,
      RuntimeContext
    >
  >
> {}

export const ListSchemaDiscoveries = Binding.Service<ListSchemaDiscoveries>(
  "StarburstGalaxy.SchemaDiscovery.ListSchemaDiscoveries",
);
