import * as discovery from "@distilled.cloud/starburst-galaxy/discovery";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { AnyCatalog } from "../Catalog/AnyCatalog.ts";
import { bindStarburstGalaxy } from "../StarburstGalaxyBindings.ts";
import {
  GetCatalogSchemaTableColumn,
  type GetCatalogSchemaTableColumnRequest,
} from "./GetCatalogSchemaTableColumn.ts";

/**
 * {@link GetCatalogSchemaTableColumn} over the Galaxy API; works on any host.
 *
 * @layer
 * @product Discovery
 * @provides StarburstGalaxy.Discovery.GetCatalogSchemaTableColumn
 */
export const GetCatalogSchemaTableColumnHttp = Layer.succeed(
  GetCatalogSchemaTableColumn,
  Effect.fn("StarburstGalaxy.Discovery.GetCatalogSchemaTableColumn")(function* (
    catalog: AnyCatalog,
  ) {
    const galaxy = yield* bindStarburstGalaxy;
    const catalogIdOf = yield* catalog.catalogId;
    return (request: GetCatalogSchemaTableColumnRequest) =>
      galaxy.authorize(
        Effect.gen(function* () {
          const catalogId = yield* catalogIdOf;
          return yield* discovery.getCatalogSchemaTableColumn({
            catalogId,
            schemaId: request.schemaName,
            tableId: request.tableName,
            columnId: request.columnName,
          });
        }),
      );
  }),
);
