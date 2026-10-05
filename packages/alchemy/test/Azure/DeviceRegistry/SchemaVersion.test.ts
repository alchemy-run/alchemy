import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as deviceregistry from "@distilled.cloud/azure/deviceregistry";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { schemaRegistry } from "./registry.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const content = (field: string) =>
  JSON.stringify({
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: { [field]: { type: "number" } },
  });

const program = (props: { field: string; description: string }) =>
  Effect.gen(function* () {
    const { group, registry, registryName } = yield* schemaRegistry;
    const schema = yield* Azure.DeviceRegistry.Schema("Schema", {
      resourceGroup: group.resourceGroupName,
      schemaRegistry: registry.schemaRegistryName,
      format: "JsonSchema/draft-07",
    });
    const version = yield* Azure.DeviceRegistry.SchemaVersion("Version", {
      resourceGroup: group.resourceGroupName,
      schemaRegistry: registryName,
      schema: schema.schemaName,
      version: "1",
      schemaContent: content(props.field),
      description: props.description,
    });
    return { group, registry, schema, version };
  });

// Free (preview) registry + cents of storage; ~3 minutes.
test.provider(
  "create, replace, and delete a schema version",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, registry, schema, version } = yield* stack.deploy(
        program({ field: "temperature", description: "first" }),
      );
      const get = Effect.gen(function* () {
        return yield* deviceregistry.GetSchemaVersion({
          subscriptionId: yield* subscription,
          resourceGroupName: group.resourceGroupName,
          schemaRegistryName: registry.schemaRegistryName,
          schemaName: schema.schemaName,
          schemaVersionName: "1",
        });
      });
      const observed = yield* get;
      expect(observed.properties?.schemaContent).toEqual(
        content("temperature"),
      );
      expect(observed.properties?.description).toEqual("first");
      expect(version.hash).toBeDefined();

      // Replacement: versions are immutable, so new content deletes and
      // recreates version "1".
      const replaced = yield* stack.deploy(
        program({ field: "pressure", description: "second" }),
      );
      expect(replaced.version.uuid).not.toEqual(version.uuid);
      const reobserved = yield* get;
      expect(reobserved.properties?.schemaContent).toEqual(content("pressure"));
      expect(reobserved.properties?.description).toEqual("second");

      yield* stack.destroy();
      expect(yield* waitGone(get)).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
