import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as deviceregistry from "@distilled.cloud/azure/deviceregistry";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { schemaRegistry } from "./registry.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getSchema = (
  resourceGroupName: string,
  schemaRegistryName: string,
  schemaName: string,
) =>
  Effect.gen(function* () {
    return yield* deviceregistry.GetSchema({
      subscriptionId: yield* subscription,
      resourceGroupName,
      schemaRegistryName,
      schemaName,
    });
  });

const program = (props: {
  format: Azure.DeviceRegistry.SchemaFormat;
  description: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const { group, registry } = yield* schemaRegistry;
    const schema = yield* Azure.DeviceRegistry.Schema("Schema", {
      resourceGroup: group.resourceGroupName,
      schemaRegistry: registry.schemaRegistryName,
      format: props.format,
      displayName: "Telemetry",
      description: props.description,
      tags: props.tags,
    });
    return { group, registry, schema };
  });

// Free (preview) registry + cents of storage; ~3 minutes.
test.provider(
  "create, update, replace, and delete a schema",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, registry, schema } = yield* stack.deploy(
        program({
          format: "JsonSchema/draft-07",
          description: "first",
          tags: { env: "a" },
        }),
      );
      const get = (name: string) =>
        getSchema(group.resourceGroupName, registry.schemaRegistryName, name);
      const observed = yield* get(schema.schemaName);
      expect(observed.properties?.format).toEqual("JsonSchema/draft-07");
      expect(observed.properties?.schemaType).toEqual("MessageSchema");
      expect(observed.properties?.description).toEqual("first");
      expect(observed.properties?.tags?.env).toEqual("a");
      expect(observed.properties?.tags?.["alchemy::id"]).toEqual("Schema");

      // In place: description and tags.
      const updated = yield* stack.deploy(
        program({
          format: "JsonSchema/draft-07",
          description: "second",
          tags: { env: "b" },
        }),
      );
      expect(updated.schema.schemaId).toEqual(schema.schemaId);
      const reobserved = yield* get(schema.schemaName);
      expect(reobserved.properties?.description).toEqual("second");
      expect(reobserved.properties?.tags?.env).toEqual("b");

      // Replacement: the format is immutable.
      const replaced = yield* stack.deploy(
        program({
          format: "Delta/1.0",
          description: "second",
          tags: { env: "b" },
        }),
      );
      expect(replaced.schema.schemaName).not.toEqual(schema.schemaName);
      expect(
        (yield* get(replaced.schema.schemaName)).properties?.format,
      ).toEqual("Delta/1.0");
      expect(yield* waitGone(get(schema.schemaName))).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getSchema(
            group.resourceGroupName,
            registry.schemaRegistryName,
            replaced.schema.schemaName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
