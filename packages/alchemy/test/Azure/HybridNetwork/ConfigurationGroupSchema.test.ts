import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as hybridnetwork from "@distilled.cloud/azure/hybridnetwork";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { location, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const schemaV1 = JSON.stringify({
  type: "object",
  properties: { region: { type: "string" } },
  required: ["region"],
});
const schemaV2 = JSON.stringify({
  type: "object",
  properties: { region: { type: "string" }, replicas: { type: "integer" } },
  required: ["region"],
});

const program = (props: {
  schemaDefinition: string;
  versionState?: "Active";
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const publisher = yield* Azure.HybridNetwork.Publisher("Publisher", {
      resourceGroup: group.resourceGroupName,
      location,
    });
    const schema = yield* Azure.HybridNetwork.ConfigurationGroupSchema(
      "Schema",
      {
        resourceGroup: group.resourceGroupName,
        publisher: publisher.publisherName,
        location,
        schemaDefinition: props.schemaDefinition,
        versionState: props.versionState,
        tags: props.tags,
      },
    );
    return { group, publisher, schema };
  });

// Free metadata resources (~2 minutes).
test.provider(
  "create, update, replace, and delete a configuration group schema",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, publisher, schema } = yield* stack.deploy(
        program({ schemaDefinition: schemaV1, tags: { env: "one" } }),
      );
      const get = (name: string) =>
        Effect.gen(function* () {
          return yield* hybridnetwork.GetConfigurationGroupSchema({
            subscriptionId: yield* subscription,
            resourceGroupName: group.resourceGroupName,
            publisherName: publisher.publisherName,
            configurationGroupSchemaName: name,
          });
        });
      const observed = yield* get(schema.configurationGroupSchemaName);
      expect(JSON.parse(observed.properties?.schemaDefinition ?? "{}")).toEqual(
        JSON.parse(schemaV1),
      );
      expect(observed.tags?.env).toEqual("one");

      // In-place: tags and publish the schema.
      const updated = yield* stack.deploy(
        program({
          schemaDefinition: schemaV1,
          versionState: "Active",
          tags: { env: "two" },
        }),
      );
      expect(updated.schema.configurationGroupSchemaId).toEqual(
        schema.configurationGroupSchemaId,
      );
      const reobserved = yield* get(schema.configurationGroupSchemaName);
      expect(reobserved.tags?.env).toEqual("two");
      expect(reobserved.properties?.versionState).toEqual("Active");

      // Replacement: the schema definition is immutable.
      const replaced = yield* stack.deploy(
        program({ schemaDefinition: schemaV2, tags: { env: "two" } }),
      );
      expect(replaced.schema.configurationGroupSchemaName).not.toEqual(
        schema.configurationGroupSchemaName,
      );
      const replacedObserved = yield* get(
        replaced.schema.configurationGroupSchemaName,
      );
      expect(
        JSON.parse(replacedObserved.properties?.schemaDefinition ?? "{}"),
      ).toEqual(JSON.parse(schemaV2));
      expect(yield* waitGone(get(schema.configurationGroupSchemaName))).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(
        yield* waitGone(get(replaced.schema.configurationGroupSchemaName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
