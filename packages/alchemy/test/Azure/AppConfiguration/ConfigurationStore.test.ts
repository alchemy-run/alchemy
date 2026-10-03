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

const getStore = (resourceGroupName: string, configStoreName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* appconfiguration.GetConfigurationStore({
      subscriptionId,
      resourceGroupName,
      configStoreName,
    });
  });

const storeGone = (resourceGroupName: string, configStoreName: string) =>
  getStore(resourceGroupName, configStoreName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 12,
    }),
  );

const softDeletedGone = (location: string, configStoreName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* appconfiguration
      .GetConfigurationStoreDeleted({
        subscriptionId,
        location,
        configStoreName,
      })
      .pipe(
        Effect.as("found" as const),
        Effect.catchTag(["ResourceNotFound", "NotFound"], () =>
          Effect.succeed("gone" as const),
        ),
      );
  }).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 12,
    }),
  );

const program = (props: {
  sku: Azure.AppConfiguration.ConfigurationStoreSku;
  disableLocalAuth: boolean;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const store = yield* Azure.AppConfiguration.ConfigurationStore("Config", {
      resourceGroup: group.resourceGroupName,
      sku: props.sku,
      disableLocalAuth: props.disableLocalAuth,
      tags: props.tags,
    });
    return { group, store };
  });

// Free stores cost nothing; the Standard step costs ~$0.05/hour, prorated
// (a run takes ~5 minutes).
test.provider(
  "create, update, upgrade, replace, and delete a configuration store",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, store } = yield* stack.deploy(
        program({
          sku: "Free",
          disableLocalAuth: false,
          tags: { env: "test" },
        }),
      );
      expect(store.configurationStoreName).toMatch(/^[a-z0-9-]{5,50}$/);
      expect(store.sku.toLowerCase()).toEqual("free");
      expect(store.endpoint).toEqual(
        `https://${store.configurationStoreName}.azconfig.io`,
      );
      expect(store.primaryConnectionString).toBeDefined();
      expect(store.primaryReadOnlyConnectionString).toBeDefined();
      const observed = yield* getStore(
        group.resourceGroupName,
        store.configurationStoreName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Config");

      // In place: tags and disableLocalAuth.
      const updated = yield* stack.deploy(
        program({ sku: "Free", disableLocalAuth: true, tags: { env: "prod" } }),
      );
      expect(updated.store.configurationStoreName).toEqual(
        store.configurationStoreName,
      );
      expect(updated.store.disableLocalAuth).toEqual(true);
      expect(updated.store.primaryConnectionString).toBeUndefined();
      const reobserved = yield* getStore(
        group.resourceGroupName,
        store.configurationStoreName,
      );
      expect(reobserved.tags?.env).toEqual("prod");
      expect(reobserved.properties?.disableLocalAuth).toEqual(true);

      // In place: SKU upgrade Free → Standard.
      const upgraded = yield* stack.deploy(
        program({
          sku: "Standard",
          disableLocalAuth: true,
          tags: { env: "prod" },
        }),
      );
      expect(upgraded.store.configurationStoreName).toEqual(
        store.configurationStoreName,
      );
      const standard = yield* getStore(
        group.resourceGroupName,
        store.configurationStoreName,
      );
      expect(standard.sku.name.toLowerCase()).toEqual("standard");

      // Replacement: a downgrade creates a new Free store and deletes (and
      // purges) the Standard one.
      const replaced = yield* stack.deploy(
        program({
          sku: "Free",
          disableLocalAuth: false,
          tags: { env: "prod" },
        }),
      );
      expect(replaced.store.configurationStoreName).not.toEqual(
        store.configurationStoreName,
      );
      expect(replaced.store.sku.toLowerCase()).toEqual("free");
      expect(
        yield* storeGone(group.resourceGroupName, store.configurationStoreName),
      ).toEqual("gone");
      expect(
        yield* softDeletedGone("eastus", store.configurationStoreName),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* storeGone(
          group.resourceGroupName,
          replaced.store.configurationStoreName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:appconfiguration", "live"],
    timeout: 900_000,
  },
);
