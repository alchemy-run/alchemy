import * as schemaDiscovery from "@distilled.cloud/starburst-galaxy/schema_discovery";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { AnyCatalog } from "../Catalog/AnyCatalog.ts";
import { bindStarburstGalaxy } from "../StarburstGalaxyBindings.ts";
import {
  DeleteSchemaDiscovery,
  type DeleteSchemaDiscoveryRequest,
} from "./DeleteSchemaDiscovery.ts";

/**
 * {@link DeleteSchemaDiscovery} over the Galaxy API; works on any host.
 *
 * @layer
 * @product SchemaDiscovery
 * @provides StarburstGalaxy.SchemaDiscovery.DeleteSchemaDiscovery
 */
export const DeleteSchemaDiscoveryHttp = Layer.succeed(
  DeleteSchemaDiscovery,
  Effect.fn("StarburstGalaxy.SchemaDiscovery.DeleteSchemaDiscovery")(function* (
    _catalog: AnyCatalog,
  ) {
    const galaxy = yield* bindStarburstGalaxy;
    return (request: DeleteSchemaDiscoveryRequest) =>
      galaxy.authorize(
        schemaDiscovery
          .deleteSchemaDiscovery({ schemaDiscoveryId: request.schemaDiscoveryId })
          .pipe(Effect.asVoid),
      );
  }),
);
