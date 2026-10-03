import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as storage from "@distilled.cloud/azure/storage";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const getContainer = (rg: string, cache: string, name: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* storage.GetContextCacheContainer({
      subscriptionId,
      resourceGroupName: rg,
      contextCacheName: cache,
      contextCacheContainerName: name,
    });
  });

const containerGone = (rg: string, cache: string, name: string) =>
  getContainer(rg, cache, name).pipe(
    Effect.as("found" as const),
    Effect.catchTag("ResourceNotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 20,
    }),
  );

interface ContainerSettings {
  modelName: string;
  description: string;
  timeToLive: number;
}

const program = (container?: ContainerSettings) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const cache = yield* Azure.Storage.ContextCache("Prompts", {
      resourceGroup: group.resourceGroupName,
    });
    const model = container
      ? yield* Azure.Storage.ContextCacheContainer("Model", {
          resourceGroup: group.resourceGroupName,
          contextCache: cache.contextCacheName,
          ...container,
        })
      : undefined;
    return { group, cache, model };
  });

// An empty Regional context cache with one container: ~$0, ~3 minutes.
test.provider(
  "create, update, replace, and delete a context cache container",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({ modelName: "gpt-4o", description: "first", timeToLive: 1 }),
      );
      const rg = created.group.resourceGroupName;
      const cache = created.cache.contextCacheName;
      const name = created.model!.contextCacheContainerName;
      expect(created.model!.provider).toEqual("OpenAI");
      const observed = yield* getContainer(rg, cache, name);
      expect(observed.properties.modelName).toEqual("gpt-4o");
      expect(observed.properties.timeToLive).toEqual(1);

      // In-place update: description and TTL.
      yield* stack.deploy(
        program({ modelName: "gpt-4o", description: "second", timeToLive: 7 }),
      );
      const reobserved = yield* getContainer(rg, cache, name);
      expect(reobserved.properties.description).toEqual("second");
      expect(reobserved.properties.timeToLive).toEqual(7);

      // Changing the model replaces the container (same name, new model).
      const replaced = yield* stack.deploy(
        program({
          modelName: "gpt-4o-mini",
          description: "second",
          timeToLive: 7,
        }),
      );
      expect(replaced.model!.modelName).toEqual("gpt-4o-mini");
      const afterReplace = yield* getContainer(
        rg,
        cache,
        replaced.model!.contextCacheContainerName,
      );
      expect(afterReplace.properties.modelName).toEqual("gpt-4o-mini");

      // Removing the resource deletes the container.
      yield* stack.deploy(program());
      expect(
        yield* containerGone(
          rg,
          cache,
          replaced.model!.contextCacheContainerName,
        ),
      ).toEqual("gone");

      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:storage", "live"],
    timeout: 900_000,
  },
);
