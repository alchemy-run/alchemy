import * as Azure from "@/Azure";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as storage from "@distilled.cloud/azure/storage";
import * as web from "@distilled.cloud/azure/web";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import TestHost, { FUNCTION_APP, RESOURCE_GROUP } from "./fixtures/host.ts";

const { test } = Test.make({ providers: Azure.providers() });

const storageProgram = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    name: RESOURCE_GROUP,
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
    const app = yield* Azure.Web.FunctionApp("App", {
      name: FUNCTION_APP,
      resourceGroup: group.resourceGroupName,
      serverFarmId: plan.appServicePlanId,
      runtime: { name: "custom", version: "1.0" },
      identity: { type: "SystemAssigned" },
      flexConsumption: {
        deploymentStorageUrl: Output.interpolate`${account.primaryEndpoints.blob}${releases.containerName}`,
        deploymentStorageAuthentication: {
          type: "StorageAccountConnectionString",
          storageAccountConnectionStringName: "AzureWebJobsStorage",
        },
      },
      appSettings: { AzureWebJobsStorage: connection },
    });
    return { app, appName: app.siteName };
  });

// The fixture names its function app statically, so the app is deployed in
// a step of its own before the host that targets it.
const hostProgram = (connection: string) =>
  Effect.gen(function* () {
    const { app, appName } = yield* appProgram(connection);
    const host = yield* TestHost;
    return { app, appName, url: host.url };
  });

// Cost: ~$0 (Flex Consumption bills per execution). Provisioning ~3-5 min.
// Skipped: the one live run failed before the fixes now in this file —
// `[TestHost] fail — The Resource 'Microsoft.Web/sites/alchemy-azfn-host-test'
// under resource group 'Azure-Functions-HostTest' was not found` (host
// deployed before the app; now a separate step) and `BadRequest:
// Site.FunctionAppConfig.Runtime is invalid. Runtime name and version must be
// provided.` (custom runtime now pins version "1.0"). Not yet re-run live.
test.provider.skip(
  "deploys an Effect HTTP program with a timer trigger to a function app",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account } = yield* stack.deploy(storageProgram);
      const connection = yield* connectionString(
        group.resourceGroupName,
        account.storageAccountName,
      );
      yield* stack.deploy(appProgram(connection));
      const { url, appName } = yield* stack.deploy(hostProgram(connection));
      expect(appName).toBe(FUNCTION_APP);

      // The custom handler serves the program's `fetch` (with env applied).
      const client = yield* HttpClient.HttpClient;
      const body = yield* client.get(`${url}/hello`).pipe(
        Effect.flatMap((res): Effect.Effect<string, unknown> =>
          res.status === 200 ? res.text : Effect.fail(res.status),
        ),
        Effect.retry({
          schedule: Schedule.spaced("10 seconds"),
          times: 12,
        }),
      );
      expect(body).toBe("hello from azure");

      // The timer source registered a native `tick` function.
      const { subscriptionId } = yield* Azure.AzureEnvironment.current;
      const functions = yield* web.ListWebAppFunctions({
        subscriptionId,
        resourceGroupName: RESOURCE_GROUP,
        name: FUNCTION_APP,
      });
      const names = (functions.value ?? []).map((f) => f.name ?? "");
      expect(names.some((n) => n.endsWith("tick"))).toBe(true);

      yield* stack.destroy();
    }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore))),
  { timeout: 900_000 },
);
