import * as discovery from "@distilled.cloud/starburst-galaxy/discovery";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { AnyCatalog } from "../Catalog/AnyCatalog.ts";
import { bindStarburstGalaxy } from "../StarburstGalaxyBindings.ts";
import {
  ListCatalogSchemaTables,
  type ListCatalogSchemaTablesRequest,
} from "./ListCatalogSchemaTables.ts";

/**
 * {@link ListCatalogSchemaTables} over the Galaxy API; works on any host.
 *
 * @layer
 * @product Discovery
 * @provides StarburstGalaxy.Discovery.ListCatalogSchemaTables
 */
export const ListCatalogSchemaTablesHttp = Layer.succeed(
  ListCatalogSchemaTables,
  Effect.fn("StarburstGalaxy.Discovery.ListCatalogSchemaTables")(function* (catalog: AnyCatalog) {
    const galaxy = yield* bindStarburstGalaxy;
    const catalogIdOf = yield* catalog.catalogId;
    return (request: ListCatalogSchemaTablesRequest) =>
      galaxy.authorize(
        Effect.gen(function* () {
          const catalogId = yield* catalogIdOf;
          return yield* discovery.listCatalogSchemaTables
            .items({ catalogId, schemaId: request.schemaName })
            .pipe(Stream.runCollect);
        }),
      );
  }),
);
