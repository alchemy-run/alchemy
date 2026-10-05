import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as storage from "@distilled.cloud/azure/storage";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const getCache = (rg: string, name: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* storage.GetContextCach({
      subscriptionId,
      resourceGroupName: rg,
      contextCacheName: name,
    });
  });

const cacheGone = (rg: string, name: string) =>
  getCache(rg, name).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 20,
    }),
  );

const program = (description: string, tags: Record<string, string>) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const cache = yield* Azure.Storage.ContextCache("Prompts", {
      resourceGroup: group.resourceGroupName,
      description,
      tags,
    });
    return { group, cache };
  });

// An empty Regional context cache: ~$0, ~2 minutes.
test.provider(
  "create, update, and delete a context cache",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program("first", { env: "test" }));
      const rg = created.group.resourceGroupName;
      const name = created.cache.contextCacheName;
      expect(created.cache.accountKind).toEqual("Regional");
      const observed = yield* getCache(rg, name);
      expect(observed.properties.description).toEqual("first");
      expect(observed.tags?.env).toEqual("test");

      // In-place update: description and tags.
      yield* stack.deploy(program("second", { env: "prod" }));
      const reobserved = yield* getCache(rg, name);
      expect(reobserved.properties.description).toEqual("second");
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(yield* cacheGone(rg, name)).toEqual("gone");
    }),
  {
    tags: ["provider:azure", "provider:azure:storage", "live"],
    timeout: 900_000,
  },
);
