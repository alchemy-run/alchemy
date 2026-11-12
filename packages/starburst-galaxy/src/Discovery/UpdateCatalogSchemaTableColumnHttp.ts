import * as discovery from "@distilled.cloud/starburst-galaxy/discovery";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { AnyCatalog } from "../Catalog/AnyCatalog.ts";
import { bindStarburstGalaxy } from "../StarburstGalaxyBindings.ts";
import {
  UpdateCatalogSchemaTableColumn,
  type UpdateCatalogSchemaTableColumnRequest,
} from "./UpdateCatalogSchemaTableColumn.ts";

/**
 * {@link UpdateCatalogSchemaTableColumn} over the Galaxy API; works on any host.
 *
 * @layer
 * @product Discovery
 * @provides StarburstGalaxy.Discovery.UpdateCatalogSchemaTableColumn
 */
export const UpdateCatalogSchemaTableColumnHttp = Layer.succeed(
  UpdateCatalogSchemaTableColumn,
  Effect.fn("StarburstGalaxy.Discovery.UpdateCatalogSchemaTableColumn")(function* (
    catalog: AnyCatalog,
  ) {
    const galaxy = yield* bindStarburstGalaxy;
    const catalogIdOf = yield* catalog.catalogId;
    return (request: UpdateCatalogSchemaTableColumnRequest) =>
      galaxy.authorize(
        Effect.gen(function* () {
          const catalogId = yield* catalogIdOf;
          return yield* discovery.updateCatalogSchemaTableColumn({
            catalogId,
            schemaId: request.schemaName,
            tableId: request.tableName,
            columnId: request.columnName,
            description: request.description,
          });
        }),
      );
  }),
);
