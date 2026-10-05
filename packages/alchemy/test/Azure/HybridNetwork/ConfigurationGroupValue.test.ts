import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as hybridnetwork from "@distilled.cloud/azure/hybridnetwork";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { location, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const schemaDefinition = JSON.stringify({
  type: "object",
  properties: { region: { type: "string" } },
  required: ["region"],
});

const program = (props: {
  configurationValue?: string;
  secretConfigurationValue?: Redacted.Redacted<string>;
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
        schemaDefinition,
        versionState: "Active",
      },
    );
    const value = yield* Azure.HybridNetwork.ConfigurationGroupValue("Value", {
      resourceGroup: group.resourceGroupName,
      location,
      configurationGroupSchemaId: schema.configurationGroupSchemaId,
      configurationValue: props.configurationValue,
      secretConfigurationValue: props.secretConfigurationValue,
      tags: props.tags,
    });
    return { group, schema, value };
  });

// Free metadata resources (~2 minutes).
test.provider(
  "create, update, replace, and delete a configuration group value",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, schema, value } = yield* stack.deploy(
        program({
          configurationValue: JSON.stringify({ region: "eastus" }),
          tags: { env: "one" },
        }),
      );
      const get = (name: string) =>
        Effect.gen(function* () {
          return yield* hybridnetwork.GetConfigurationGroupValue({
            subscriptionId: yield* subscription,
            resourceGroupName: group.resourceGroupName,
            configurationGroupValueName: name,
          });
        });
      expect(value.configurationType).toEqual("Open");
      expect(value.configurationGroupSchemaId.toLowerCase()).toEqual(
        schema.configurationGroupSchemaId.toLowerCase(),
      );
      const observed = yield* get(value.configurationGroupValueName);
      expect(JSON.parse(observed.properties?.configurationValue ?? "{}")).toEqual(
        { region: "eastus" },
      );
      expect(observed.tags?.env).toEqual("one");

      // In-place: values and tags.
      const updated = yield* stack.deploy(
        program({
          configurationValue: JSON.stringify({ region: "westus3" }),
          tags: { env: "two" },
        }),
      );
      expect(updated.value.configurationGroupValueId).toEqual(
        value.configurationGroupValueId,
      );
      const reobserved = yield* get(value.configurationGroupValueName);
      expect(
        JSON.parse(reobserved.properties?.configurationValue ?? "{}"),
      ).toEqual({ region: "westus3" });
      expect(reobserved.tags?.env).toEqual("two");

      // Replacement: switching open -> secret replaces the value.
      const replaced = yield* stack.deploy(
        program({
          secretConfigurationValue: Redacted.make(
            JSON.stringify({ region: "centralus" }),
          ),
          tags: { env: "two" },
        }),
      );
      expect(replaced.value.configurationGroupValueName).not.toEqual(
        value.configurationGroupValueName,
      );
      expect(replaced.value.configurationType).toEqual("Secret");
      expect(replaced.value.secretValueHash).toBeDefined();
      const secretObserved = yield* get(
        replaced.value.configurationGroupValueName,
      );
      expect(secretObserved.properties?.configurationType).toEqual("Secret");
      expect(yield* waitGone(get(value.configurationGroupValueName))).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(
        yield* waitGone(get(replaced.value.configurationGroupValueName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
