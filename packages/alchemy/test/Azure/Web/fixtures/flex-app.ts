import * as Azure from "@/Azure";
import * as Output from "@/Output";
import * as storage from "@distilled.cloud/azure/storage";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

/**
 * A Flex Consumption (FC1) function app in eastus. FC1 plans have free-trial
 * quota in eastus and are not affected by the F1 plan-create throttle in
 * centralus, so site child resources that work on any plan test against it.
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
