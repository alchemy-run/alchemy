import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as appconfiguration from "@distilled.cloud/azure/appconfiguration";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getSnapshot = (
  resourceGroupName: string,
  configStoreName: string,
  snapshotName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* appconfiguration.GetSnapshot({
      subscriptionId,
      resourceGroupName,
      configStoreName,
      snapshotName,
    });
  });

const storeGone = (resourceGroupName: string, configStoreName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* appconfiguration
      .GetConfigurationStore({
        subscriptionId,
        resourceGroupName,
        configStoreName,
      })
      .pipe(
        Effect.as("found" as const),
        Effect.catchTag(
          ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
          () => Effect.succeed("gone" as const),
        ),
      );
  }).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 12,
    }),
  );

const program = (compositionType: "Key" | "Key_Label") =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const store = yield* Azure.AppConfiguration.ConfigurationStore("Config", {
      resourceGroup: group.resourceGroupName,
      sku: "Standard",
    });
    const setting = yield* Azure.AppConfiguration.KeyValue("Setting", {
      resourceGroup: group.resourceGroupName,
      configurationStore: store.configurationStoreName,
      key: "App:Color",
      value: "blue",
    });
    const snapshot = yield* Azure.AppConfiguration.Snapshot("Release", {
      resourceGroup: group.resourceGroupName,
      configurationStore: setting.configurationStore,
      filters: [{ key: "App:*" }],
      compositionType,
      retentionPeriod: 3600,
      tags: { release: "v1" },
    });
    return { group, store, snapshot };
  });

// Standard store: ~$0.05/hour, prorated (a run takes ~3-5 minutes).
test.provider(
  "create, replace, and delete a configuration snapshot",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, store, snapshot } = yield* stack.deploy(program("Key"));
      expect(snapshot.status).toEqual("Ready");
      expect(snapshot.itemsCount).toEqual(1);
      expect(snapshot.compositionType).toEqual("Key");
      expect(snapshot.tags).toEqual({ release: "v1" });
      const observed = yield* getSnapshot(
        group.resourceGroupName,
        store.configurationStoreName,
        snapshot.snapshotName,
      );
      expect(observed.properties?.filters?.map((f) => f.key)).toEqual([
        "App:*",
      ]);
      expect(observed.properties?.tags?.["alchemy::id"]).toEqual("Release");

      // Replacement: snapshots are immutable, so a new composition type
      // creates a new snapshot.
      const replaced = yield* stack.deploy(program("Key_Label"));
      expect(replaced.snapshot.snapshotName).not.toEqual(snapshot.snapshotName);
      expect(replaced.snapshot.compositionType).toEqual("Key_Label");
      const replacedObserved = yield* getSnapshot(
        group.resourceGroupName,
        store.configurationStoreName,
        replaced.snapshot.snapshotName,
      );
      expect(replacedObserved.properties?.status).toEqual("Ready");

      // Snapshots have no ARM delete; they go away with their store.
      yield* stack.destroy();
      expect(
        yield* storeGone(group.resourceGroupName, store.configurationStoreName),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:appconfiguration", "live"],
    timeout: 900_000,
  },
);
