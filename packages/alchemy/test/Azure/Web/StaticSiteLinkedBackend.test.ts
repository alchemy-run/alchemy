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

const getLink = (
  resourceGroupName: string,
  name: string,
  linkedBackendName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* web.GetStaticSiteLinkedBackend({
      subscriptionId,
      resourceGroupName,
      name,
      linkedBackendName,
    });
  });

const linkGone = (
  resourceGroupName: string,
  name: string,
  linkedBackendName: string,
) =>
  getLink(resourceGroupName, name, linkedBackendName).pipe(
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

const storageProgram = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: "eastus2",
  });
  const account = yield* Azure.Storage.StorageAccount("Storage", {
    resourceGroup: group.resourceGroupName,
    location: "eastus",
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

const program = (connection: string) =>
  Effect.gen(function* () {
    const { group, account, releases } = yield* storageProgram;
    const plan = yield* Azure.Web.AppServicePlan("Plan", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      sku: "FC1",
    });
    const api = yield* Azure.Web.FunctionApp("Api", {
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
    const site = yield* Azure.Web.StaticSite("Site", {
      resourceGroup: group.resourceGroupName,
      sku: "Standard",
    });
    const link = yield* Azure.Web.StaticSiteLinkedBackend("ApiLink", {
      resourceGroup: group.resourceGroupName,
      staticSiteName: site.staticSiteName,
      backendResourceId: api.siteId,
      region: api.location,
    });
    return { group, api, site, link };
  });

// Cost: Standard static site ~$9/month prorated (~$0.0125/h, a few cents per
// run); Flex Consumption idle $0. Provisioning: ~4-6 minutes.
test.provider(
  "link and unlink a function app backend on a static site",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account } = yield* stack.deploy(storageProgram);
      const connection = yield* connectionString(
        group.resourceGroupName,
        account.storageAccountName,
      );

      const { api, site, link } = yield* stack.deploy(program(connection));
      expect(link.backendResourceId.toLowerCase()).toEqual(
        api.siteId.toLowerCase(),
      );
      expect(link.provisioningState).toEqual("Succeeded");
      const observed = yield* getLink(
        group.resourceGroupName,
        site.staticSiteName,
        link.linkedBackendName,
      );
      expect(observed.properties?.backendResourceId?.toLowerCase()).toEqual(
        api.siteId.toLowerCase(),
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");

      // A redeploy without changes leaves the link in place.
      const same = yield* stack.deploy(program(connection));
      expect(same.link.linkedBackendId).toEqual(link.linkedBackendId);

      yield* stack.destroy();
      expect(
        yield* linkGone(
          group.resourceGroupName,
          site.staticSiteName,
          link.linkedBackendName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 600_000,
  },
);
