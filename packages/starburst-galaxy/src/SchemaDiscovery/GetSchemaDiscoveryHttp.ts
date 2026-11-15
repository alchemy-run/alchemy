import * as schemaDiscovery from "@distilled.cloud/starburst-galaxy/schema_discovery";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { AnyCatalog } from "../Catalog/AnyCatalog.ts";
import { bindStarburstGalaxy } from "../StarburstGalaxyBindings.ts";
import { GetSchemaDiscovery, type GetSchemaDiscoveryRequest } from "./GetSchemaDiscovery.ts";

/**
 * {@link GetSchemaDiscovery} over the Galaxy API; works on any host.
 *
 * @layer
 * @product SchemaDiscovery
 * @provides StarburstGalaxy.SchemaDiscovery.GetSchemaDiscovery
 */
export const GetSchemaDiscoveryHttp = Layer.succeed(
  GetSchemaDiscovery,
  Effect.fn("StarburstGalaxy.SchemaDiscovery.GetSchemaDiscovery")(function* (_catalog: AnyCatalog) {
    const galaxy = yield* bindStarburstGalaxy;
    return (request: GetSchemaDiscoveryRequest) =>
      galaxy.authorize(
        schemaDiscovery.getSchemaDiscovery({ schemaDiscoveryId: request.schemaDiscoveryId }),
      );
  }),
);
