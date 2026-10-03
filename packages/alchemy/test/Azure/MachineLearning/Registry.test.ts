import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as ml from "@distilled.cloud/azure/machinelearningservices";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { location, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getRegistry = (resourceGroupName: string, registryName: string) =>
  Effect.gen(function* () {
    return yield* ml.GetRegistry({
      subscriptionId: yield* subscription,
      resourceGroupName,
      registryName,
    });
  });

const program = (props: { tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const registry = yield* Azure.MachineLearning.Registry("Shared", {
      resourceGroup: group.resourceGroupName,
      location,
      tags: props.tags,
    });
    return { group, registry };
  });

// A registry provisions a managed resource group with a Premium container
// registry (~$0.07/hour) and a storage account; creation and deletion take
// ~5-7 minutes each (~15 minutes, ~$0.05 per run). Replacement is not
// exercised (name is the only replace trigger and doubles the runtime).
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a machine learning registry",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, registry } = yield* stack.deploy(
        program({ tags: { env: "test" } }),
      );
      const get = (name: string) => getRegistry(group.resourceGroupName, name);
      expect(registry.regions.map((r) => r.toLowerCase())).toContain(location);
      expect(registry.managedResourceGroup).toBeTruthy();
      const observed = yield* get(registry.registryName);
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Shared");

      // In-place: tags (PATCH).
      const updated = yield* stack.deploy(program({ tags: { env: "prod" } }));
      expect(updated.registry.registryId).toEqual(registry.registryId);
      const reobserved = yield* get(registry.registryName);
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(yield* waitGone(get(registry.registryName))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
