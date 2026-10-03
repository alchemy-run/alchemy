import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as databasewatcher from "@distilled.cloud/azure/databasewatcher";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const getWatcher = (resourceGroupName: string, watcherName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* databasewatcher.GetWatcher({
      subscriptionId,
      resourceGroupName,
      watcherName,
    });
  });

const watcherGone = (resourceGroupName: string, watcherName: string) =>
  getWatcher(resourceGroupName, watcherName).pipe(
    Effect.as("found" as const),
    Effect.catchTag("ResourceNotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
  );

const program = (watcher?: { name?: string; tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const w = watcher
      ? yield* Azure.DatabaseWatcher.Watcher("Watcher", {
          resourceGroup: group.resourceGroupName,
          name: watcher.name,
          tags: watcher.tags,
        })
      : undefined;
    return { group, watcher: w };
  });

// The watcher itself is free (no data store, no targets, never started).
test.provider(
  "create, update, replace, and delete a database watcher",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program({ tags: { env: "test" } }));
      const rg = created.group.resourceGroupName;
      const first = created.watcher!;
      expect(first.watcherName).toMatch(/^[a-z][a-z0-9-]{2,59}$/);
      expect(first.identityType).toEqual("SystemAssigned");
      expect(first.principalId).toBeTruthy();
      expect(first.tags).toEqual({ env: "test" });
      const observed = yield* getWatcher(rg, first.watcherName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Watcher");

      // In-place tag update.
      const updated = yield* stack.deploy(
        program({ tags: { env: "prod", owner: "ops" } }),
      );
      expect(updated.watcher!.watcherId).toEqual(first.watcherId);
      const reobserved = yield* getWatcher(rg, first.watcherName);
      expect(reobserved.tags?.env).toEqual("prod");
      expect(reobserved.tags?.owner).toEqual("ops");

      // Renaming replaces the watcher.
      const renamed = yield* stack.deploy(
        program({ name: "alchemy-renamed-watcher", tags: {} }),
      );
      expect(renamed.watcher!.watcherName).toEqual("alchemy-renamed-watcher");
      const replacement = yield* getWatcher(rg, "alchemy-renamed-watcher");
      expect(replacement.tags?.["alchemy::id"]).toEqual("Watcher");
      expect(yield* watcherGone(rg, first.watcherName)).toEqual("gone");

      // Removing the watcher from the stack deletes it.
      yield* stack.deploy(program());
      expect(yield* watcherGone(rg, "alchemy-renamed-watcher")).toEqual("gone");

      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:databasewatcher", "live"],
    timeout: 900_000,
  },
);
