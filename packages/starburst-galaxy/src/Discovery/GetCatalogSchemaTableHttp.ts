import * as discovery from "@distilled.cloud/starburst-galaxy/discovery";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { AnyCatalog } from "../Catalog/AnyCatalog.ts";
import { bindStarburstGalaxy } from "../StarburstGalaxyBindings.ts";
import {
  GetCatalogSchemaTable,
  type GetCatalogSchemaTableRequest,
} from "./GetCatalogSchemaTable.ts";

/**
 * {@link GetCatalogSchemaTable} over the Galaxy API; works on any host.
 *
 * @layer
 * @product Discovery
 * @provides StarburstGalaxy.Discovery.GetCatalogSchemaTable
 */
export const GetCatalogSchemaTableHttp = Layer.succeed(
  GetCatalogSchemaTable,
  Effect.fn("StarburstGalaxy.Discovery.GetCatalogSchemaTable")(function* (catalog: AnyCatalog) {
    const galaxy = yield* bindStarburstGalaxy;
    const catalogIdOf = yield* catalog.catalogId;
    return (request: GetCatalogSchemaTableRequest) =>
      galaxy.authorize(
        Effect.gen(function* () {
          const catalogId = yield* catalogIdOf;
          return yield* discovery.getCatalogSchemaTable({
            catalogId,
            schemaId: request.schemaName,
            tableId: request.tableName,
          });
        }),
      );
  }),
);
