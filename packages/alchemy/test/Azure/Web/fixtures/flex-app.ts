import * as Azure from "@/Azure";
import * as Output from "@/Output";
import * as storage from "@distilled.cloud/azure/storage";
import * as web from "@distilled.cloud/azure/web";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

/**
 * A Flex Consumption (FC1) function app in eastus, for site child resources
 * that work on any plan. See `flexPlanRejection` for why lifecycles on it are
 * gated on the testing subscription.
 */
export const flexStorage = Effect.gen(function* () {
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

/** Connection string of the storage account (read out of band). */
export const flexConnectionString = (
  resourceGroupName: string,
  accountName: string,
) =>
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

export const flexApp = (connection: string) =>
  Effect.gen(function* () {
    const { group, account, releases } = yield* flexStorage;
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

/**
 * The testing subscription is barred from creating Flex Consumption plans:
 * every region answers HTTP 502 "The subscription '<id>' is not allowed to
 * create or update the serverfarm." (`ServerFarmCreateNotAllowed`). Tests
 * on a Flex app run only with AZURE_TEST_PAID=1 and keep this probe ungated.
 */
export const flexPlanRejection = (resourceGroupName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* web
      .AppServicePlansCreateOrUpdate({
        subscriptionId,
        resourceGroupName,
        name: "alchemy-flex-probe",
        location: "eastus",
        kind: "functionapp,linux",
        sku: { name: "FC1", tier: "FlexConsumption" },
        properties: { reserved: true },
      })
      .pipe(Effect.flip);
  });
