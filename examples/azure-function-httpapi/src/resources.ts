import * as Azure from "@alchemy.run/azure";
import * as Effect from "effect/Effect";

/**
 * The storage account that holds the job table. It is separate from the
 * account Alchemy creates for the Functions host, so app data never shares
 * a blast radius with deployment packages.
 */
export const Data = Azure.Storage.StorageAccount("Data", {
  sku: "Standard_LRS",
});

/** One entity per job: `PartitionKey` `"jobs"`, `RowKey` the job ID. */
export const Jobs = Effect.gen(function* () {
  const account = yield* Data;
  return yield* Azure.Storage.Table("Jobs", {
    storageAccount: account.storageAccountName,
  });
});

/** The partition every job lives in. */
export const JOB_PARTITION = "jobs";
