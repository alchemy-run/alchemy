import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as resources from "@distilled.cloud/azure/resources";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getGroup = (resourceGroupName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* resources.GetResourceGroup({
      subscriptionId,
      resourceGroupName,
    });
  });

const waitUntilGone = (resourceGroupName: string) =>
  getGroup(resourceGroupName).pipe(
    Effect.as("found" as const),
    Effect.catchTag("ResourceGroupNotFound", () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 12,
    }),
  );

test.provider(
  "create, update, replace, and delete a resource group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Azure.Resources.ResourceGroup("Group", {
          location: "eastus",
          tags: { env: "test" },
        }),
      );
      expect(created.location).toEqual("eastus");
      expect(created.tags).toEqual({ env: "test" });
      expect(created.resourceGroupId).toMatch(
        new RegExp(`/resourceGroups/${created.resourceGroupName}$`, "i"),
      );

      const observed = yield* getGroup(created.resourceGroupName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Group");

      // Tag update keeps the same group.
      const updated = yield* stack.deploy(
        Azure.Resources.ResourceGroup("Group", {
          location: "eastus",
          tags: { env: "prod", team: "platform" },
        }),
      );
      expect(updated.resourceGroupName).toEqual(created.resourceGroupName);
      expect(updated.tags).toEqual({ env: "prod", team: "platform" });
      const retagged = yield* getGroup(updated.resourceGroupName);
      expect(retagged.tags?.env).toEqual("prod");
      expect(retagged.tags?.team).toEqual("platform");

      // A location change replaces the group.
      const replaced = yield* stack.deploy(
        Azure.Resources.ResourceGroup("Group", {
          location: "westus2",
          tags: { env: "prod", team: "platform" },
        }),
      );
      expect(replaced.resourceGroupName).not.toEqual(created.resourceGroupName);
      expect(replaced.location).toEqual("westus2");
      expect(yield* waitUntilGone(created.resourceGroupName)).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitUntilGone(replaced.resourceGroupName)).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:resources", "live"],
    timeout: 300_000,
  },
);
