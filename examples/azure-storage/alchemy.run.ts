import * as Azure from "@alchemy.run/azure";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "AzureStorageExample",
  {
    providers: Azure.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    // Both resources go into the stack's resource group,
    // "AzureStorageExample-<stage>", which Alchemy creates and deletes.
    const account = yield* Azure.Storage.StorageAccount("files", {
      sku: "Standard_LRS",
    });

    const uploads = yield* Azure.Storage.BlobContainer("uploads", {
      storageAccount: account.storageAccountName,
    });

    return {
      resourceGroup: account.resourceGroup,
      storageAccount: account.storageAccountName,
      blobEndpoint: account.primaryEndpoints.blob,
      container: uploads.containerName,
    };
  }),
);
