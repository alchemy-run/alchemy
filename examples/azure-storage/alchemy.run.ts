import * as Alchemy from "alchemy";
import * as Azure from "alchemy/Azure";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "AzureStorageExample",
  {
    providers: Azure.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("app");

    const account = yield* Azure.Storage.StorageAccount("files", {
      resourceGroup: group.resourceGroupName,
      sku: "Standard_LRS",
    });

    const uploads = yield* Azure.Storage.BlobContainer("uploads", {
      resourceGroup: group.resourceGroupName,
      storageAccount: account.storageAccountName,
    });

    return {
      resourceGroup: group.resourceGroupName,
      storageAccount: account.storageAccountName,
      blobEndpoint: account.primaryEndpoints.blob,
      container: uploads.containerName,
    };
  }),
);
