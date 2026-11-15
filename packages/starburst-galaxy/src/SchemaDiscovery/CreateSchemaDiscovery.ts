import type * as schemaDiscovery from "@distilled.cloud/starburst-galaxy/schema_discovery";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { AnyCatalog } from "../Catalog/AnyCatalog.ts";

/** What `createSchemaDiscovery` takes. */
export interface CreateSchemaDiscoveryRequest {
  /** Object storage location to scan, e.g. `s3://acme-lake/events/`. */
  readonly uri: string;
  /** Schema the discovered tables go in. */
  readonly defaultSchemaName?: string;
  /** Galaxy's discovery options (file format hints). */
  readonly options?: Readonly<Record<string, string>>;
  /** Only propose the SQL; apply it later with `ApplySchemaDiscovery`. Default `false`. */
  readonly skipApplying?: boolean;
  /** Scan everything instead of what changed since the last run. Default `false`. */
  readonly forceFullDiscovery?: boolean;
}

/**
 * Start a schema discovery on the bound object-storage catalog: Galaxy
 * scans a location, infers tables from the files, and creates (or
 * proposes) them.
 *
 * The host calls Galaxy as the deploying profile's API client: Galaxy
 * can't mint a key per host or trust a host's identity (see
 * `StarburstGalaxyBindings`), so the client's role bounds what the host
 * may do.
 *
 * ### Calling it from a Worker
 * **Example:** CreateSchemaDiscovery
 * ```typescript
 * const shop = StarburstGalaxy.Catalog.PostgresqlCatalog.lookup({ name: "shop" });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const createSchemaDiscovery = yield* StarburstGalaxy.SchemaDiscovery.CreateSchemaDiscovery(shop);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const run = yield* createSchemaDiscovery({ uri: "s3://acme-lake/events/", skipApplying: true });
 *         return yield* HttpServerResponse.json(run.schemaDiscoveryId);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(StarburstGalaxy.SchemaDiscovery.CreateSchemaDiscoveryHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product SchemaDiscovery
 */
export interface CreateSchemaDiscovery extends Binding.Service<
  CreateSchemaDiscovery,
  "StarburstGalaxy.SchemaDiscovery.CreateSchemaDiscovery",
  (
    catalog: AnyCatalog,
  ) => Effect.Effect<
    (
      request: CreateSchemaDiscoveryRequest,
    ) => Effect.Effect<
      schemaDiscovery.SchemaDiscovery,
      schemaDiscovery.CreateSchemaDiscoveryError,
      RuntimeContext
    >
  >
> {}

export const CreateSchemaDiscovery = Binding.Service<CreateSchemaDiscovery>(
  "StarburstGalaxy.SchemaDiscovery.CreateSchemaDiscovery",
);
