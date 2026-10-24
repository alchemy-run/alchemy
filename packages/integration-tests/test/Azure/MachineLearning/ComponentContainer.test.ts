import * as Azure from "@alchemy.run/azure";
import * as ml from "@distilled.cloud/azure/machinelearningservices";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { location, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getContainer = (resourceGroupName: string, registryName: string, componentName: string) =>
  Effect.gen(function* () {
    return yield* ml.GetRegistryComponentContainer({
      subscriptionId: yield* subscription,
      resourceGroupName,
      registryName,
      componentName,
    });
  });

const program = (props: {
  name?: string;
  description: string;
  tags: Record<string, string>;
  isArchived?: boolean;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const registry = yield* Azure.MachineLearning.Registry("Shared", {
      resourceGroup: group.resourceGroupName,
      location,
    });
    const container = yield* Azure.MachineLearning.ComponentContainer("Prep", {
      resourceGroup: group.resourceGroupName,
      registry: registry.registryName,
      ...props,
    });
    return { group, registry, container };
  });

// ~$0.10/run, 20 min: component containers are managed only in registries, and a
// registry provisions a managed Premium container registry and storage
// account (~5-7 minutes each to create and delete).
test.provider.skipIf(!runExpensive)(
  "create, update, rename, and delete a component container",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, registry, container } = yield* stack.deploy(
        program({ description: "prep", tags: { env: "test" } }),
      );
      const get = (name: string) =>
        getContainer(group.resourceGroupName, registry.registryName, name);
      expect(container.registry).toEqual(registry.registryName);
      expect(container.workspace).toBeUndefined();
      expect(container.tags).toEqual({ env: "test" });
      const observed = yield* get(container.containerName);
      expect(observed.properties.description).toEqual("prep");
      expect(observed.properties.tags?.["alchemy::id"]).toEqual("Prep");

      // In place: description, tags, archive flag.
      const updated = yield* stack.deploy(
        program({ description: "prep v2", tags: { env: "prod" }, isArchived: true }),
      );
      expect(updated.container.containerId).toEqual(container.containerId);
      const reobserved = yield* get(container.containerName);
      expect(reobserved.properties.description).toEqual("prep v2");
      expect(reobserved.properties.tags?.env).toEqual("prod");
      expect(reobserved.properties.isArchived).toEqual(true);

      // Replacement: an explicit name.
      const renamed = yield* stack.deploy(
        program({ name: "alchemy-prep-renamed", description: "renamed", tags: {} }),
      );
      expect(renamed.container.containerName).toEqual("alchemy-prep-renamed");
      expect(yield* waitGone(get(container.containerName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get("alchemy-prep-renamed"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 1_800_000 },
);
