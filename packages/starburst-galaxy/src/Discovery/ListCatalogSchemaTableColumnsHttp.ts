import * as discovery from "@distilled.cloud/starburst-galaxy/discovery";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { AnyCatalog } from "../Catalog/AnyCatalog.ts";
import { bindStarburstGalaxy } from "../StarburstGalaxyBindings.ts";
import {
  ListCatalogSchemaTableColumns,
  type ListCatalogSchemaTableColumnsRequest,
} from "./ListCatalogSchemaTableColumns.ts";

/**
 * {@link ListCatalogSchemaTableColumns} over the Galaxy API; works on any host.
 *
 * @layer
 * @product Discovery
 * @provides StarburstGalaxy.Discovery.ListCatalogSchemaTableColumns
 */
export const ListCatalogSchemaTableColumnsHttp = Layer.succeed(
  ListCatalogSchemaTableColumns,
  Effect.fn("StarburstGalaxy.Discovery.ListCatalogSchemaTableColumns")(function* (
    catalog: AnyCatalog,
  ) {
    const galaxy = yield* bindStarburstGalaxy;
    const catalogIdOf = yield* catalog.catalogId;
    return (request: ListCatalogSchemaTableColumnsRequest) =>
      galaxy.authorize(
        Effect.gen(function* () {
          const catalogId = yield* catalogIdOf;
          return yield* discovery.listCatalogSchemaTableColumns
            .items({ catalogId, schemaId: request.schemaName, tableId: request.tableName })
            .pipe(Stream.runCollect);
        }),
      );
  }),
);
