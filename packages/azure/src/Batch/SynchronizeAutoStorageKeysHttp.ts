import * as batch from "@distilled.cloud/azure/batch";
import * as Layer from "effect/Layer";
import { BatchArmRole, makeBatchAccountActionBinding } from "./ArmBindingHttp.ts";
import { SynchronizeAutoStorageKeys } from "./SynchronizeAutoStorageKeys.ts";

/**
 * Implementation of {@link SynchronizeAutoStorageKeys} over the distilled `batch` ARM
 * API. Assigns the custom `AzureBatchSynchronizeAutoStorageKeysRole` on the Batch account
 * and `AzureBatchReadAutoStorageKeysRole` on its auto-storage account.
 *
 * @layer
 * @provides Azure.Batch.SynchronizeAutoStorageKeys
 */
export const SynchronizeAutoStorageKeysHttp = Layer.effect(
  SynchronizeAutoStorageKeys,
  makeBatchAccountActionBinding({
    tag: "Azure.Batch.SynchronizeAutoStorageKeys",
    operation: batch.BatchAccountSynchronizeAutoStorageKeys,
    role: BatchArmRole.SynchronizeAutoStorageKeys,
    also: (account) => [
      {
        role: BatchArmRole.ReadAutoStorageKeys,
        scope: account.autoStorageAccountId.as<string>(),
      },
    ],
  }),
);
