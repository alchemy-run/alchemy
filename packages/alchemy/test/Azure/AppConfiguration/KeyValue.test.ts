import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as appconfiguration from "@distilled.cloud/azure/appconfiguration";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getKeyValue = (
  resourceGroupName: string,
  configStoreName: string,
  keyValueName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* appconfiguration.GetKeyValue({
      subscriptionId,
      resourceGroupName,
      configStoreName,
      keyValueName,
    });
  });

const keyValueGone = (
  resourceGroupName: string,
  configStoreName: string,
  keyValueName: string,
) =>
  getKeyValue(resourceGroupName, configStoreName, keyValueName).pipe(
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

const program = (props: {
  key: string;
  value: string | Redacted.Redacted<string>;
  contentType?: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const store = yield* Azure.AppConfiguration.ConfigurationStore("Config", {
      resourceGroup: group.resourceGroupName,
      sku: "Free",
    });
    const setting = yield* Azure.AppConfiguration.KeyValue("Setting", {
      resourceGroup: group.resourceGroupName,
      configurationStore: store.configurationStoreName,
      key: props.key,
      label: "prod",
      value: props.value,
      contentType: props.contentType,
      tags: props.tags,
    });
    return { group, store, setting };
  });

// Free store: no cost.
test.provider(
  "create, update, replace, and delete a key-value",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, store, setting } = yield* stack.deploy(
        program({
          key: "App/Settings:Color",
          value: "blue",
          tags: { team: "web" },
        }),
      );
      expect(setting.keyValueName).toEqual("App~2FSettings:Color$prod");
      expect(setting.label).toEqual("prod");
      expect(setting.tags).toEqual({ team: "web" });
      const observed = yield* getKeyValue(
        group.resourceGroupName,
        store.configurationStoreName,
        setting.keyValueName,
      );
      expect(observed.properties?.key).toEqual("App/Settings:Color");
      expect(observed.properties?.label).toEqual("prod");
      expect(observed.properties?.value).toEqual("blue");
      expect(observed.properties?.tags?.["alchemy::id"]).toEqual("Setting");

      // In place: value (as a secret), content type, and tags.
      const updated = yield* stack.deploy(
        program({
          key: "App/Settings:Color",
          value: Redacted.make('{"hex":"#00f"}'),
          contentType: "application/json",
          tags: { team: "platform" },
        }),
      );
      expect(updated.setting.keyValueId).toEqual(setting.keyValueId);
      expect(updated.setting.contentType).toEqual("application/json");
      const reobserved = yield* getKeyValue(
        group.resourceGroupName,
        store.configurationStoreName,
        setting.keyValueName,
      );
      expect(reobserved.properties?.value).toEqual('{"hex":"#00f"}');
      expect(reobserved.properties?.contentType).toEqual("application/json");
      expect(reobserved.properties?.tags?.team).toEqual("platform");

      // Replacement: renaming the key.
      const renamed = yield* stack.deploy(
        program({
          key: "App:Theme",
          value: "dark",
          tags: { team: "platform" },
        }),
      );
      expect(renamed.setting.keyValueName).toEqual("App:Theme$prod");
      const renamedObserved = yield* getKeyValue(
        group.resourceGroupName,
        store.configurationStoreName,
        "App:Theme$prod",
      );
      expect(renamedObserved.properties?.value).toEqual("dark");
      expect(
        yield* keyValueGone(
          group.resourceGroupName,
          store.configurationStoreName,
          setting.keyValueName,
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* keyValueGone(
          group.resourceGroupName,
          store.configurationStoreName,
          "App:Theme$prod",
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:appconfiguration", "live"],
    timeout: 900_000,
  },
);
