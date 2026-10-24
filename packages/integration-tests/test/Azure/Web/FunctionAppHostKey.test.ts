import * as Azure from "@alchemy.run/azure";
import * as storage from "@distilled.cloud/azure/storage";
import * as web from "@distilled.cloud/azure/web";
import { expect } from "alchemy-test";
import * as Output from "alchemy/Output";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { flexConnectionString, flexStorage } from "./fixtures/flex-app.ts";
import { windowsFunctionApp } from "./fixtures/windows-function-app.ts";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const hostKeys = (resourceGroupName: string, name: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* web.ListWebAppHostKeys({
      subscriptionId,
      resourceGroupName,
      name,
    });
  });

const keyGone = (
  resourceGroupName: string,
  name: string,
  keyType: "functionKeys" | "systemKeys",
  keyName: string,
) =>
  hostKeys(resourceGroupName, name).pipe(
    Effect.map((keys) => (keys[keyType]?.[keyName] === undefined ? "gone" : "found")),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const storageProgram = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: "eastus",
  });
  const account = yield* Azure.Storage.StorageAccount("Storage", {
    resourceGroup: group.resourceGroupName,
  });
  const releases = yield* Azure.Storage.BlobContainer("Releases", {
    resourceGroup: group.resourceGroupName,
    storageAccount: account.storageAccountName,
  });
  return { group, account, releases };
});

const connectionString = (resourceGroupName: string, accountName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const { keys } = yield* storage.ListStorageAccountKeys({
      subscriptionId,
      resourceGroupName,
      accountName,
    });
    const key = keys?.[0]?.value as string | Redacted.Redacted<string>;
    const value = Redacted.isRedacted(key) ? Redacted.value(key) : key;
    return `DefaultEndpointsProtocol=https;AccountName=${accountName};AccountKey=${value};EndpointSuffix=core.windows.net`;
  });

const appProgram = (connection: string) =>
  Effect.gen(function* () {
    const { group, account, releases } = yield* storageProgram;
    const plan = yield* Azure.Web.AppServicePlan("Plan", {
      resourceGroup: group.resourceGroupName,
      sku: "FC1",
    });
    const app = yield* Azure.Web.FunctionApp("Api", {
      resourceGroup: group.resourceGroupName,
      serverFarmId: plan.appServicePlanId,
      runtime: { name: "node", version: "20" },
      flexConsumption: {
        deploymentStorageUrl: Output.interpolate`${account.primaryEndpoints.blob}${releases.containerName}`,
        deploymentStorageAuthentication: {
          type: "StorageAccountConnectionString",
          storageAccountConnectionStringName: "AzureWebJobsStorage",
        },
      },
      appSettings: { AzureWebJobsStorage: connection },
    });
    return { group, app };
  });

const program = (props: {
  connection: string;
  keyType: "functionKeys" | "systemKeys";
  value: string | undefined;
}) =>
  Effect.gen(function* () {
    const { group, app } = yield* appProgram(props.connection);
    const key = yield* Azure.Web.FunctionAppHostKey("PartnerKey", {
      resourceGroup: group.resourceGroupName,
      functionAppName: app.siteName,
      keyType: props.keyType,
      value: props.value ? Redacted.make(props.value) : undefined,
    });
    return { group, app, key };
  });

const explicitValue = "alchemyTestHostKeyValue0123456789abcdef";

// Cost: ~$0 (Flex Consumption, idle; Standard_LRS storage). Provisioning:
// ~3-5 minutes (the Functions host must start before keys can be managed).
test.provider(
  "create, update, replace, and delete a function app host key",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account } = yield* stack.deploy(storageProgram);
      const connection = yield* connectionString(
        group.resourceGroupName,
        account.storageAccountName,
      );

      const { app, key } = yield* stack.deploy(
        program({ connection, keyType: "functionKeys", value: undefined }),
      );
      expect(key.keyType).toEqual("functionKeys");
      const generated = Redacted.value(key.value);
      expect(generated.length).toBeGreaterThanOrEqual(32);
      const observed = yield* hostKeys(group.resourceGroupName, app.siteName);
      expect(observed.functionKeys?.[key.keyName]).toEqual(generated);

      // A redeploy without a value keeps the generated key.
      const same = yield* stack.deploy(
        program({ connection, keyType: "functionKeys", value: undefined }),
      );
      expect(Redacted.value(same.key.value)).toEqual(generated);

      // In-place update: set an explicit value.
      const updated = yield* stack.deploy(
        program({ connection, keyType: "functionKeys", value: explicitValue }),
      );
      expect(updated.key.keyName).toEqual(key.keyName);
      expect(Redacted.value(updated.key.value)).toEqual(explicitValue);
      const reobserved = yield* hostKeys(group.resourceGroupName, app.siteName).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("3 seconds"),
          until: (keys) => keys.functionKeys?.[key.keyName] === explicitValue,
          times: 10,
        }),
      );
      expect(reobserved.functionKeys?.[key.keyName]).toEqual(explicitValue);

      // Replacement: the key type cannot change in place.
      const replaced = yield* stack.deploy(
        program({ connection, keyType: "systemKeys", value: explicitValue }),
      );
      expect(replaced.key.keyType).toEqual("systemKeys");
      const system = yield* hostKeys(group.resourceGroupName, app.siteName);
      expect(system.systemKeys?.[replaced.key.keyName]).toEqual(explicitValue);
      expect(
        yield* keyGone(group.resourceGroupName, app.siteName, "functionKeys", key.keyName),
      ).toEqual("gone");

      // Remove only the key, verifying delete while the host is running.
      yield* stack.deploy(appProgram(connection));
      expect(
        yield* keyGone(group.resourceGroupName, app.siteName, "systemKeys", replaced.key.keyName),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 600_000,
  },
);

const slotHostKeys = (resourceGroupName: string, name: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* web.ListWebAppHostKeysSlot({
      subscriptionId,
      resourceGroupName,
      name,
      slot: "staging",
    });
  });

const slotHostKeyValue = "alchemyTestSlotHostKeyValue0123456789abcd";

const slotProgram = (connection: string, withKey: boolean) =>
  Effect.gen(function* () {
    const { group, app, slot } = yield* windowsFunctionApp(connection);
    const key = withKey
      ? yield* Azure.Web.FunctionAppHostKey("SlotHostKey", {
          resourceGroup: group.resourceGroupName,
          functionAppName: app.siteName,
          slot: slot.slotName,
          value: Redacted.make(slotHostKeyValue),
        })
      : undefined;
    return { group, app, key };
  });

// S1 Windows plan: ~$0.10/h, about $0.03 per run (Standard_LRS storage).
// Provisioning: ~5-7 minutes (slot host start).
test.provider(
  "create and delete a host key in a deployment slot",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account } = yield* stack.deploy(flexStorage);
      const connection = yield* flexConnectionString(
        group.resourceGroupName,
        account.storageAccountName,
      );
      const { app, key } = yield* stack.deploy(slotProgram(connection, true));
      expect(key?.slot).toEqual("staging");
      const observed = yield* slotHostKeys(group.resourceGroupName, app.siteName);
      expect(observed.functionKeys?.[key?.keyName ?? ""]).toEqual(slotHostKeyValue);

      // Delete only the key.
      yield* stack.deploy(slotProgram(connection, false));
      const remaining = yield* slotHostKeys(group.resourceGroupName, app.siteName).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("3 seconds"),
          until: (keys) => keys.functionKeys?.[key?.keyName ?? ""] === undefined,
          times: 10,
        }),
      );
      expect(remaining.functionKeys?.[key?.keyName ?? ""]).toEqual(undefined);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 900_000,
  },
);
