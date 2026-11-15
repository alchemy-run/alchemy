import * as discovery from "@distilled.cloud/starburst-galaxy/discovery";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { AnyCatalog } from "../Catalog/AnyCatalog.ts";
import { bindStarburstGalaxy } from "../StarburstGalaxyBindings.ts";
import { GetCatalogMetadata } from "./GetCatalogMetadata.ts";

/**
 * {@link GetCatalogMetadata} over the Galaxy API; works on any host.
 *
 * @layer
 * @product Discovery
 * @provides StarburstGalaxy.Discovery.GetCatalogMetadata
 */
export const GetCatalogMetadataHttp = Layer.succeed(
  GetCatalogMetadata,
  Effect.fn("StarburstGalaxy.Discovery.GetCatalogMetadata")(function* (catalog: AnyCatalog) {
    const galaxy = yield* bindStarburstGalaxy;
    const catalogIdOf = yield* catalog.catalogId;
    return () =>
      galaxy.authorize(
        Effect.gen(function* () {
          const catalogId = yield* catalogIdOf;
          return yield* discovery.getCatalogMetadata({ catalogId });
        }),
      );
  }),
);
