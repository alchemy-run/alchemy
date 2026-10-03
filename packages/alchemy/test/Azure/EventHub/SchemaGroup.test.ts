import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as eventhub from "@distilled.cloud/azure/eventhub";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getSchemaGroup = (
  resourceGroupName: string,
  namespaceName: string,
  schemaGroupName: string,
) =>
  Effect.gen(function* () {
    return yield* eventhub.GetSchemaRegistry({
      subscriptionId: yield* subscription,
      resourceGroupName,
      namespaceName,
      schemaGroupName,
    });
  });

const program = (props: {
  schemaType: Azure.EventHub.SchemaType;
  schemaCompatibility: Azure.EventHub.SchemaCompatibility;
  groupProperties: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    // The schema registry needs a Standard namespace.
    const namespace = yield* Azure.EventHub.Namespace("Events", {
      resourceGroup: group.resourceGroupName,
      sku: "Standard",
    });
    const schemas = yield* Azure.EventHub.SchemaGroup("Schemas", {
      resourceGroup: group.resourceGroupName,
      namespace: namespace.namespaceName,
      ...props,
    });
    return { group, namespace, schemas };
  });

// Standard namespace (~$0.03/hour) for a few minutes: well under $0.05.
test.provider(
  "create, update, replace, and delete a schema group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, namespace, schemas } = yield* stack.deploy(
        program({
          schemaType: "Avro",
          schemaCompatibility: "None",
          groupProperties: {},
        }),
      );
      const get = (name: string) =>
        getSchemaGroup(group.resourceGroupName, namespace.namespaceName, name);
      expect(schemas.schemaType).toEqual("Avro");
      const observed = yield* get(schemas.schemaGroupName);
      expect(observed.properties?.schemaType).toEqual("Avro");
      expect(observed.properties?.schemaCompatibility).toEqual("None");

      // In-place: group properties.
      const updated = yield* stack.deploy(
        program({
          schemaType: "Avro",
          schemaCompatibility: "None",
          groupProperties: { team: "orders" },
        }),
      );
      expect(updated.schemas.schemaGroupId).toEqual(schemas.schemaGroupId);
      const reobserved = yield* get(schemas.schemaGroupName);
      expect(reobserved.properties?.schemaCompatibility).toEqual("None");
      expect(reobserved.properties?.groupProperties?.team).toEqual("orders");

      // Replacement: compatibility is immutable (and Json groups only
      // accept "None", so this stays Avro).
      const replaced = yield* stack.deploy(
        program({
          schemaType: "Avro",
          schemaCompatibility: "Backward",
          groupProperties: { team: "orders" },
        }),
      );
      expect(replaced.schemas.schemaGroupName).not.toEqual(
        schemas.schemaGroupName,
      );
      const replacedObserved = yield* get(replaced.schemas.schemaGroupName);
      expect(replacedObserved.properties?.schemaType).toEqual("Avro");
      expect(replacedObserved.properties?.schemaCompatibility).toEqual(
        "Backward",
      );
      expect(replacedObserved.properties?.groupProperties?.team).toEqual(
        "orders",
      );
      expect(yield* waitGone(get(schemas.schemaGroupName))).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(get(replaced.schemas.schemaGroupName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
