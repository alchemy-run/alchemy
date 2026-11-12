import * as schemaDiscovery from "@distilled.cloud/starburst-galaxy/schema_discovery";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { AnyCatalog } from "../Catalog/AnyCatalog.ts";
import { bindStarburstGalaxy } from "../StarburstGalaxyBindings.ts";
import {
  CreateSchemaDiscovery,
  type CreateSchemaDiscoveryRequest,
} from "./CreateSchemaDiscovery.ts";

/**
 * {@link CreateSchemaDiscovery} over the Galaxy API; works on any host.
 *
 * @layer
 * @product SchemaDiscovery
 * @provides StarburstGalaxy.SchemaDiscovery.CreateSchemaDiscovery
 */
export const CreateSchemaDiscoveryHttp = Layer.succeed(
  CreateSchemaDiscovery,
  Effect.fn("StarburstGalaxy.SchemaDiscovery.CreateSchemaDiscovery")(function* (
    catalog: AnyCatalog,
  ) {
    const galaxy = yield* bindStarburstGalaxy;
    const catalogIdOf = yield* catalog.catalogId;
    return (request: CreateSchemaDiscoveryRequest) =>
      galaxy.authorize(
        Effect.gen(function* () {
          const catalogId = yield* catalogIdOf;
          return yield* schemaDiscovery.createSchemaDiscovery({
            catalogId,
            uri: request.uri,
            defaultSchemaName: request.defaultSchemaName,
            options: { ...request.options },
            skipApplying: request.skipApplying ?? false,
            forceFullDiscovery: request.forceFullDiscovery ?? false,
          });
        }),
      );
  }),
);
