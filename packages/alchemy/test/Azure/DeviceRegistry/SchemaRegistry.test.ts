import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as deviceregistry from "@distilled.cloud/azure/deviceregistry";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { registryStorage } from "./registry.ts";
import { location, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getRegistry = (resourceGroupName: string, schemaRegistryName: string) =>
  Effect.gen(function* () {
    return yield* deviceregistry.GetSchemaRegistry({
      subscriptionId: yield* subscription,
      resourceGroupName,
      schemaRegistryName,
    });
  });

const program = (props: {
  namespace?: string;
  description: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const { group, containerUrl } = yield* registryStorage;
    const registry = yield* Azure.DeviceRegistry.SchemaRegistry("Registry", {
      resourceGroup: group.resourceGroupName,
      location,
      storageAccountContainerUrl: containerUrl,
      namespace: props.namespace,
      displayName: "Alchemy test registry",
      description: props.description,
      tags: props.tags,
    });
    return { group, registry };
  });

// A schema registry is free (preview); the backing Standard_LRS storage
// account costs cents. Provisioning takes ~2 minutes.
test.provider(
  "create, update, replace, and delete a schema registry",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, registry } = yield* stack.deploy(
        program({ description: "first", tags: { env: "a" } }),
      );
      const get = (name: string) => getRegistry(group.resourceGroupName, name);
      const observed = yield* get(registry.schemaRegistryName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.description).toEqual("first");
      expect(observed.properties?.namespace).toEqual(registry.namespace);
      expect(registry.namespace.length).toBeLessThanOrEqual(32);
      expect(observed.identity?.type).toEqual("SystemAssigned");
      expect(registry.principalId).not.toEqual("");
      expect(observed.tags?.env).toEqual("a");

      // In place: description and tags.
      const updated = yield* stack.deploy(
        program({ description: "second", tags: { env: "b" } }),
      );
      expect(updated.registry.schemaRegistryId).toEqual(
        registry.schemaRegistryId,
      );
      const reobserved = yield* get(registry.schemaRegistryName);
      expect(reobserved.properties?.description).toEqual("second");
      expect(reobserved.tags?.env).toEqual("b");

      // Replacement: the registry namespace is immutable.
      const replaced = yield* stack.deploy(
        program({
          namespace: `${registry.namespace.slice(0, 28)}-ns`,
          description: "second",
          tags: { env: "b" },
        }),
      );
      expect(replaced.registry.schemaRegistryName).not.toEqual(
        registry.schemaRegistryName,
      );
      expect(replaced.registry.namespace).toEqual(
        `${registry.namespace.slice(0, 28)}-ns`,
      );
      expect(yield* waitGone(get(registry.schemaRegistryName))).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(get(replaced.registry.schemaRegistryName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
