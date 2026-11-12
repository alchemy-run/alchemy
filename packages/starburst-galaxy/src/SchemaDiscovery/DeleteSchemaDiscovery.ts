import type * as schemaDiscovery from "@distilled.cloud/starburst-galaxy/schema_discovery";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { AnyCatalog } from "../Catalog/AnyCatalog.ts";

/** What `deleteSchemaDiscovery` takes. */
export interface DeleteSchemaDiscoveryRequest {
  /** ID of the discovery run. */
  readonly schemaDiscoveryId: string;
}

/**
 * Delete a schema discovery run of the bound catalog. Galaxy refuses
 * (`PreconditionFailed`) a run in progress or the latest applied one.
 *
 * The host calls Galaxy as the deploying profile's API client: Galaxy
 * can't mint a key per host or trust a host's identity (see
 * `StarburstGalaxyBindings`), so the client's role bounds what the host
 * may do.
 *
 * ### Calling it from a Worker
 * **Example:** DeleteSchemaDiscovery
 * ```typescript
 * const shop = StarburstGalaxy.Catalog.PostgresqlCatalog.lookup({ name: "shop" });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const deleteSchemaDiscovery = yield* StarburstGalaxy.SchemaDiscovery.DeleteSchemaDiscovery(shop);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* deleteSchemaDiscovery({ schemaDiscoveryId });
 *         return yield* HttpServerResponse.json("deleted");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(StarburstGalaxy.SchemaDiscovery.DeleteSchemaDiscoveryHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product SchemaDiscovery
 */
export interface DeleteSchemaDiscovery extends Binding.Service<
  DeleteSchemaDiscovery,
  "StarburstGalaxy.SchemaDiscovery.DeleteSchemaDiscovery",
  (
    catalog: AnyCatalog,
  ) => Effect.Effect<
    (
      request: DeleteSchemaDiscoveryRequest,
    ) => Effect.Effect<void, schemaDiscovery.DeleteSchemaDiscoveryError, RuntimeContext>
  >
> {}

export const DeleteSchemaDiscovery = Binding.Service<DeleteSchemaDiscovery>(
  "StarburstGalaxy.SchemaDiscovery.DeleteSchemaDiscovery",
);
