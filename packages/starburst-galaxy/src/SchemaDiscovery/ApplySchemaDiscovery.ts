import type * as schemaDiscovery from "@distilled.cloud/starburst-galaxy/schema_discovery";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { AnyCatalog } from "../Catalog/AnyCatalog.ts";

/** What `applySchemaDiscovery` takes. */
export interface ApplySchemaDiscoveryRequest {
  /** ID of the discovery run. */
  readonly schemaDiscoveryId: string;
}

/**
 * Run the SQL a schema discovery of the bound catalog proposed (one
 * started with `skipApplying`).
 *
 * The host calls Galaxy as the deploying profile's API client: Galaxy
 * can't mint a key per host or trust a host's identity (see
 * `StarburstGalaxyBindings`), so the client's role bounds what the host
 * may do.
 *
 * ### Calling it from a Worker
 * **Example:** ApplySchemaDiscovery
 * ```typescript
 * const shop = StarburstGalaxy.Catalog.PostgresqlCatalog.lookup({ name: "shop" });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const applySchemaDiscovery = yield* StarburstGalaxy.SchemaDiscovery.ApplySchemaDiscovery(shop);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const run = yield* applySchemaDiscovery({ schemaDiscoveryId });
 *         return yield* HttpServerResponse.json(run.status);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(StarburstGalaxy.SchemaDiscovery.ApplySchemaDiscoveryHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product SchemaDiscovery
 */
export interface ApplySchemaDiscovery extends Binding.Service<
  ApplySchemaDiscovery,
  "StarburstGalaxy.SchemaDiscovery.ApplySchemaDiscovery",
  (
    catalog: AnyCatalog,
  ) => Effect.Effect<
    (
      request: ApplySchemaDiscoveryRequest,
    ) => Effect.Effect<
      schemaDiscovery.SchemaDiscovery,
      schemaDiscovery.ApplySchemaDiscoveryError,
      RuntimeContext
    >
  >
> {}

export const ApplySchemaDiscovery = Binding.Service<ApplySchemaDiscovery>(
  "StarburstGalaxy.SchemaDiscovery.ApplySchemaDiscovery",
);
