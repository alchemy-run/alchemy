import * as discovery from "@distilled.cloud/starburst-galaxy/discovery";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { AnyCatalog } from "../Catalog/AnyCatalog.ts";
import { bindStarburstGalaxy } from "../StarburstGalaxyBindings.ts";
import { ListCatalogSchemas } from "./ListCatalogSchemas.ts";

/**
 * {@link ListCatalogSchemas} over the Galaxy API; works on any host.
 *
 * @layer
 * @product Discovery
 * @provides StarburstGalaxy.Discovery.ListCatalogSchemas
 */
export const ListCatalogSchemasHttp = Layer.succeed(
  ListCatalogSchemas,
  Effect.fn("StarburstGalaxy.Discovery.ListCatalogSchemas")(function* (catalog: AnyCatalog) {
    const galaxy = yield* bindStarburstGalaxy;
    const catalogIdOf = yield* catalog.catalogId;
    return () =>
      galaxy.authorize(
        Effect.gen(function* () {
          const catalogId = yield* catalogIdOf;
          return yield* discovery.listCatalogSchemas.items({ catalogId }).pipe(Stream.runCollect);
        }),
      );
  }),
);
