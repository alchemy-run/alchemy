import * as Azure from "@/Azure";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as storage from "@distilled.cloud/azure/storage";
import * as web from "@distilled.cloud/azure/web";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { runPaidOnly } from "../gates.ts";
import {
  flexConnectionString,
  flexPlanRejection,
  flexStorage,
} from "./fixtures/flex-app.ts";
import {
  FUNCTION_NAME,
  FUNCTION_ZIP_BASE64,
} from "./fixtures/powershell-function.ts";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const functionKeys = (resourceGroupName: string, name: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* web.ListWebAppFunctionKeys({
      subscriptionId,
      resourceGroupName,
      name,
      functionName: FUNCTION_NAME,
    });
  });

const keyGone = (resourceGroupName: string, name: string, keyName: string) =>
  functionKeys(resourceGroupName, name).pipe(
    Effect.map((keys) =>
      keys.properties?.[keyName] === undefined ? "gone" : "found",
    ),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const appProgram = (connection: string) =>
  Effect.gen(function* () {
    const { group, account, releases } = yield* flexStorage;
    const plan = yield* Azure.Web.AppServicePlan("Plan", {
      resourceGroup: group.resourceGroupName,
      sku: "FC1",
    });
    const app = yield* Azure.Web.FunctionApp("Api", {
      resourceGroup: group.resourceGroupName,
      serverFarmId: plan.appServicePlanId,
      runtime: { name: "powershell", version: "7.4" },
      flexConsumption: {
        deploymentStorageUrl: Output.interpolate`${account.primaryEndpoints.blob}${releases.containerName}`,
        deploymentStorageAuthentication: {
          type: "StorageAccountConnectionString",
          storageAccountConnectionStringName: "AzureWebJobsStorage",
        },
      },
      appSettings: { AzureWebJobsStorage: connection },
    });
    return { group, account, releases, app };
  });

/** Upload the function package and publish it with ARM OneDeploy. */
const deployPackage = (props: {
  resourceGroupName: string;
  accountName: string;
  blobEndpoint: string;
  container: string;
  siteName: string;
}) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const expiry = yield* Effect.sync(() =>
      new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    );
    const { accountSasToken } = yield* storage.ListStorageAccountAccountSAS({
      subscriptionId,
      resourceGroupName: props.resourceGroupName,
      accountName: props.accountName,
      signedServices: "b",
      signedResourceTypes: "o",
      signedPermission: "rcw",
      signedProtocol: "https",
      signedExpiry: expiry,
    });
    const packageUrl = `${props.blobEndpoint}${props.container}/function-key-test.zip`;
    const bytes = yield* Effect.sync(() =>
      Uint8Array.from(Buffer.from(FUNCTION_ZIP_BASE64, "base64")),
    );
    const client = yield* HttpClient.HttpClient;
    const uploaded = yield* client.execute(
      HttpClientRequest.put(`${packageUrl}?${accountSasToken}`).pipe(
        HttpClientRequest.setHeader("x-ms-blob-type", "BlockBlob"),
        HttpClientRequest.bodyUint8Array(bytes, "application/zip"),
      ),
    );
    expect(uploaded.status).toEqual(201);
    yield* web.WebAppsCreateOneDeployOperation({
      subscriptionId,
      resourceGroupName: props.resourceGroupName,
      name: props.siteName,
      properties: {
        packageUri: `${packageUrl}?${accountSasToken}`,
        type: "zip",
        remoteBuild: false,
      },
    });
    // The host indexes the function once the package is live.
    return yield* web
      .GetWebAppFunction({
        subscriptionId,
        resourceGroupName: props.resourceGroupName,
        name: props.siteName,
        functionName: FUNCTION_NAME,
      })
      .pipe(
        Effect.retry({
          while: (e) => e._tag === "ResourceNotFound" || e._tag === "NotFound",
          schedule: Schedule.spaced("10 seconds"),
          times: 30,
        }),
      );
  });

const program = (connection: string, value: string | undefined) =>
  Effect.gen(function* () {
    const { group, app } = yield* appProgram(connection);
    const key = yield* Azure.Web.FunctionKey("WebhookKey", {
      resourceGroup: group.resourceGroupName,
      functionAppName: app.siteName,
      functionName: FUNCTION_NAME,
      value: value ? Redacted.make(value) : undefined,
    });
    return { group, app, key };
  });

const explicitValue = "alchemyTestFunctionKeyValue0123456789abc";

// The testing subscription may not create Flex Consumption plans (HTTP 502
// "The subscription '<id>' is not allowed to create or update the
// serverfarm.", ServerFarmCreateNotAllowed, in every region), so this runs
// only with AZURE_TEST_PAID=1. Cost: ~$0 (Flex Consumption,
// idle; Standard_LRS storage). Provisioning: ~4-6 minutes (package publish +
// host start).
test.provider.skipIf(!runPaidOnly)(
  "create, update, and delete a function key",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account } = yield* stack.deploy(flexStorage);
      const connection = yield* flexConnectionString(
        group.resourceGroupName,
        account.storageAccountName,
      );
      const { app, releases } = yield* stack.deploy(appProgram(connection));
      yield* deployPackage({
        resourceGroupName: group.resourceGroupName,
        accountName: account.storageAccountName,
        blobEndpoint: account.primaryEndpoints.blob ?? "",
        container: releases.containerName,
        siteName: app.siteName,
      });

      const { key } = yield* stack.deploy(program(connection, undefined));
      expect(key.functionName).toEqual(FUNCTION_NAME);
      const generated = Redacted.value(key.value);
      expect(generated.length).toBeGreaterThanOrEqual(32);
      const observed = yield* functionKeys(
        group.resourceGroupName,
        app.siteName,
      );
      expect(observed.properties?.[key.keyName]).toEqual(generated);

      // A redeploy without a value keeps the generated key.
      const same = yield* stack.deploy(program(connection, undefined));
      expect(Redacted.value(same.key.value)).toEqual(generated);

      // In-place update: set an explicit value.
      const updated = yield* stack.deploy(program(connection, explicitValue));
      expect(updated.key.keyName).toEqual(key.keyName);
      expect(Redacted.value(updated.key.value)).toEqual(explicitValue);
      const reobserved = yield* functionKeys(
        group.resourceGroupName,
        app.siteName,
      ).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("3 seconds"),
          until: (keys) => keys.properties?.[key.keyName] === explicitValue,
          times: 10,
        }),
      );
      expect(reobserved.properties?.[key.keyName]).toEqual(explicitValue);

      // Delete only the key while the host is running.
      yield* stack.deploy(appProgram(connection));
      expect(
        yield* keyGone(group.resourceGroupName, app.siteName, key.keyName),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 900_000,
  },
);

// Probe: the subscription cannot create the Flex Consumption plan this
// lifecycle needs.
test.provider(
  "flex consumption plan is rejected with ServerFarmCreateNotAllowed",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          return { group };
        }),
      );
      const error = yield* flexPlanRejection(group.resourceGroupName);
      expect(error._tag).toEqual("ServerFarmCreateNotAllowed");
      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 300_000,
  },
);
