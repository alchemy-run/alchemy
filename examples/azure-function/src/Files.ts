import * as Azure from "@alchemy.run/azure";
import * as Effect from "effect/Effect";

/** The storage account that holds the uploaded files. */
export const Data = Azure.Storage.StorageAccount("Data");

/** The blob container the Function reads and writes. */
export const Files = Effect.gen(function* () {
  const account = yield* Data;
  return yield* Azure.Storage.BlobContainer("Files", {
    storageAccount: account.storageAccountName,
  });
});
