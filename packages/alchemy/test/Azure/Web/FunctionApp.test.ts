import * as Azure from "@/Azure";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as storage from "@distilled.cloud/azure/storage";
import * as web from "@distilled.cloud/azure/web";
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

const where = (resourceGroupName: string, name: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return { subscriptionId, resourceGroupName, name };
  });

const getApp = (resourceGroupName: string, name: string) =>
  where(resourceGroupName, name).pipe(Effect.flatMap(web.GetWebApp));

const appGone = (resourceGroupName: string, name: string) =>
  getApp(resourceGroupName, name).pipe(
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

/** Storage the Functions host and Flex deployments use. */
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
  const releasesV2 = yield* Azure.Storage.BlobContainer("ReleasesV2", {
    resourceGroup: group.resourceGroupName,
    storageAccount: account.storageAccountName,
  });
  return { group, account, releases, releasesV2 };
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

const program = (props: {
  connection: string;
  container: "releases" | "releasesV2";
  maximumInstanceCount: number;
  appSettings: Record<string, string>;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const { group, account, releases, releasesV2 } = yield* storageProgram;
    const plan = yield* Azure.Web.AppServicePlan("Plan", {
      resourceGroup: group.resourceGroupName,
      sku: "FC1",
    });
    const container = props.container === "releases" ? releases : releasesV2;
    const app = yield* Azure.Web.FunctionApp("Api", {
      resourceGroup: group.resourceGroupName,
      serverFarmId: plan.appServicePlanId,
      runtime: { name: "node", version: "20" },
      flexConsumption: {
        deploymentStorageUrl: Output.interpolate`${account.primaryEndpoints.blob}${container.containerName}`,
        deploymentStorageAuthentication: {
          type: "StorageAccountConnectionString",
          storageAccountConnectionStringName: "AzureWebJobsStorage",
        },
        maximumInstanceCount: props.maximumInstanceCount,
        instanceMemoryMB: 2048,
      },
      appSettings: {
        AzureWebJobsStorage: props.connection,
        ...props.appSettings,
      },
      tags: props.tags,
    });
    return { group, app, container };
  });

// Cost: ~$0 (Flex Consumption bills per execution; idle apps cost nothing,
// Standard_LRS storage is cents per month). Provisioning: ~2-4 minutes.
test.provider(
  "create, update, replace, and delete a flex consumption function app",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account } = yield* stack.deploy(storageProgram);
      const connection = yield* connectionString(
        group.resourceGroupName,
        account.storageAccountName,
      );

      const { app, container } = yield* stack.deploy(
        program({
          connection,
          container: "releases",
          maximumInstanceCount: 40,
          appSettings: { GREETING: "hello" },
          tags: { env: "test" },
        }),
      );
      expect(app.kind).toEqual("functionapp,linux");
      expect(app.siteName.length).toBeLessThanOrEqual(32);
      expect(app.defaultHostName).toEqual(`${app.siteName}.azurewebsites.net`);

      const observed = yield* getApp(group.resourceGroupName, app.siteName);
      const config = observed.properties?.functionAppConfig;
      expect(config?.runtime?.name).toEqual("node");
      expect(config?.runtime?.version).toEqual("20");
      expect(config?.scaleAndConcurrency?.maximumInstanceCount).toEqual(40);
      expect(config?.deployment?.storage?.value).toContain(
        container.containerName,
      );
      expect(observed.tags?.env).toEqual("test");
      const settings = yield* where(group.resourceGroupName, app.siteName).pipe(
        Effect.flatMap(web.ListWebAppApplicationSettings),
      );
      expect(settings.properties?.GREETING).toEqual("hello");
      expect(settings.properties?.FUNCTIONS_WORKER_RUNTIME).toBeUndefined();

      // In-place update: scale limit (PUT-only), app settings, and tags.
      const updated = yield* stack.deploy(
        program({
          connection,
          container: "releases",
          maximumInstanceCount: 50,
          appSettings: { GREETING: "bonjour" },
          tags: { env: "prod" },
        }),
      );
      expect(updated.app.siteName).toEqual(app.siteName);
      const reobserved = yield* getApp(group.resourceGroupName, app.siteName);
      expect(
        reobserved.properties?.functionAppConfig?.scaleAndConcurrency
          ?.maximumInstanceCount,
      ).toEqual(50);
      expect(reobserved.tags?.env).toEqual("prod");
      const resettings = yield* where(
        group.resourceGroupName,
        app.siteName,
      ).pipe(Effect.flatMap(web.ListWebAppApplicationSettings));
      expect(resettings.properties?.GREETING).toEqual("bonjour");

      // Replacement: the deployment container cannot change in place.
      const replaced = yield* stack.deploy(
        program({
          connection,
          container: "releasesV2",
          maximumInstanceCount: 50,
          appSettings: { GREETING: "bonjour" },
          tags: { env: "prod" },
        }),
      );
      expect(replaced.app.siteName).not.toEqual(app.siteName);
      const moved = yield* getApp(
        group.resourceGroupName,
        replaced.app.siteName,
      );
      expect(
        moved.properties?.functionAppConfig?.deployment?.storage?.value,
      ).toContain(replaced.container.containerName);
      expect(yield* appGone(group.resourceGroupName, app.siteName)).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(
        yield* appGone(group.resourceGroupName, replaced.app.siteName),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 600_000,
  },
);
