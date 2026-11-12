import * as discovery from "@distilled.cloud/starburst-galaxy/discovery";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { AnyCatalog } from "../Catalog/AnyCatalog.ts";
import { bindStarburstGalaxy } from "../StarburstGalaxyBindings.ts";
import { GetCatalogSchema, type GetCatalogSchemaRequest } from "./GetCatalogSchema.ts";

/**
 * {@link GetCatalogSchema} over the Galaxy API; works on any host.
 *
 * @layer
 * @product Discovery
 * @provides StarburstGalaxy.Discovery.GetCatalogSchema
 */
export const GetCatalogSchemaHttp = Layer.succeed(
  GetCatalogSchema,
  Effect.fn("StarburstGalaxy.Discovery.GetCatalogSchema")(function* (catalog: AnyCatalog) {
    const galaxy = yield* bindStarburstGalaxy;
    const catalogIdOf = yield* catalog.catalogId;
    return (request: GetCatalogSchemaRequest) =>
      galaxy.authorize(
        Effect.gen(function* () {
          const catalogId = yield* catalogIdOf;
          return yield* discovery.getCatalogSchema({ catalogId, schemaId: request.schemaName });
        }),
      );
  }),
);
