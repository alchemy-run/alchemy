import type * as schemaDiscovery from "@distilled.cloud/starburst-galaxy/schema_discovery";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { AnyCatalog } from "../Catalog/AnyCatalog.ts";

/** What `getSchemaDiscovery` takes. */
export interface GetSchemaDiscoveryRequest {
  /** ID of the discovery run. */
  readonly schemaDiscoveryId: string;
}

/**
 * Read a schema discovery run of the bound catalog: its status, the SQL
 * it proposed and the tables it created, updated or deleted.
 *
 * The host calls Galaxy as the deploying profile's API client: Galaxy
 * can't mint a key per host or trust a host's identity (see
 * `StarburstGalaxyBindings`), so the client's role bounds what the host
 * may do.
 *
 * ### Calling it from a Worker
 * **Example:** GetSchemaDiscovery
 * ```typescript
 * const shop = StarburstGalaxy.Catalog.PostgresqlCatalog.lookup({ name: "shop" });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const getSchemaDiscovery = yield* StarburstGalaxy.SchemaDiscovery.GetSchemaDiscovery(shop);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const run = yield* getSchemaDiscovery({ schemaDiscoveryId });
 *         return yield* HttpServerResponse.json(run.status);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(StarburstGalaxy.SchemaDiscovery.GetSchemaDiscoveryHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product SchemaDiscovery
 */
export interface GetSchemaDiscovery extends Binding.Service<
  GetSchemaDiscovery,
  "StarburstGalaxy.SchemaDiscovery.GetSchemaDiscovery",
  (
    catalog: AnyCatalog,
  ) => Effect.Effect<
    (
      request: GetSchemaDiscoveryRequest,
    ) => Effect.Effect<
      schemaDiscovery.SchemaDiscovery,
      schemaDiscovery.GetSchemaDiscoveryError,
      RuntimeContext
    >
  >
> {}

export const GetSchemaDiscovery = Binding.Service<GetSchemaDiscovery>(
  "StarburstGalaxy.SchemaDiscovery.GetSchemaDiscovery",
);
