import * as schemaDiscovery from "@distilled.cloud/starburst-galaxy/schema_discovery";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { AnyCatalog } from "../Catalog/AnyCatalog.ts";
import { bindStarburstGalaxy } from "../StarburstGalaxyBindings.ts";
import { ApplySchemaDiscovery, type ApplySchemaDiscoveryRequest } from "./ApplySchemaDiscovery.ts";

/**
 * {@link ApplySchemaDiscovery} over the Galaxy API; works on any host.
 *
 * @layer
 * @product SchemaDiscovery
 * @provides StarburstGalaxy.SchemaDiscovery.ApplySchemaDiscovery
 */
export const ApplySchemaDiscoveryHttp = Layer.succeed(
  ApplySchemaDiscovery,
  Effect.fn("StarburstGalaxy.SchemaDiscovery.ApplySchemaDiscovery")(function* (
    _catalog: AnyCatalog,
  ) {
    const galaxy = yield* bindStarburstGalaxy;
    return (request: ApplySchemaDiscoveryRequest) =>
      galaxy.authorize(
        schemaDiscovery.applySchemaDiscovery({ schemaDiscoveryId: request.schemaDiscoveryId }),
      );
  }),
);
