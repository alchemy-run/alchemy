import * as Azure from "@alchemy.run/azure";
import * as Effect from "effect/Effect";

/**
 * The storage account. Under `alchemy dev` it is Azurite's development
 * account (`devstoreaccount1`); under `alchemy deploy` a Standard_LRS account.
 */
export const Data = Azure.Storage.StorageAccount("Data");

/** The container the Function reads and writes, and where the consumer records jobs. */
export const Files = Effect.gen(function* () {
  const account = yield* Data;
  return yield* Azure.Storage.BlobContainer("Files", {
    storageAccount: account.storageAccountName,
  });
});

/** The queue the Function sends to and consumes. */
export const Jobs = Effect.gen(function* () {
  const account = yield* Data;
  return yield* Azure.Storage.Queue("Jobs", {
    storageAccount: account.storageAccountName,
  });
});
