import * as schemaDiscovery from "@distilled.cloud/starburst-galaxy/schema_discovery";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { AnyCatalog } from "../Catalog/AnyCatalog.ts";
import { bindStarburstGalaxy } from "../StarburstGalaxyBindings.ts";
import {
  ListSchemaDiscoveries,
  type ListSchemaDiscoveriesRequest,
} from "./ListSchemaDiscoveries.ts";

/**
 * {@link ListSchemaDiscoveries} over the Galaxy API; works on any host.
 *
 * @layer
 * @product SchemaDiscovery
 * @provides StarburstGalaxy.SchemaDiscovery.ListSchemaDiscoveries
 */
export const ListSchemaDiscoveriesHttp = Layer.succeed(
  ListSchemaDiscoveries,
  Effect.fn("StarburstGalaxy.SchemaDiscovery.ListSchemaDiscoveries")(function* (
    catalog: AnyCatalog,
  ) {
    const galaxy = yield* bindStarburstGalaxy;
    const catalogIdOf = yield* catalog.catalogId;
    return (request?: ListSchemaDiscoveriesRequest) =>
      galaxy.authorize(
        Effect.gen(function* () {
          const catalogId = yield* catalogIdOf;
          return yield* schemaDiscovery.listSchemaDiscoveries
            .items({ catalogId, latest: request?.latest })
            .pipe(Stream.runCollect);
        }),
      );
  }),
);
