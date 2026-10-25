import type * as batch from "@distilled.cloud/azure/batch";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface SynchronizeAutoStorageKeysRequest extends Omit<
  batch.BatchAccountSynchronizeAutoStorageKeysRequest,
  "subscriptionId" | "resourceGroupName" | "accountName"
> {}

/**
 * Make the Batch account re-read its auto-storage account's keys after a key rotation (`POST …/batchAccounts/{accountName}/syncAutoStorageKeys`) from any host.
 *
 * Binding assigns a custom role (`AzureBatchSynchronizeAutoStorageKeysRole`, one per stack, with
 * exactly the action `Microsoft.Batch/batchAccounts/syncAutoStorageKeys/action`) on the Batch account, plus `AzureBatchReadAutoStorageKeysRole`
 * (`Microsoft.Storage/storageAccounts/read` and
 * `Microsoft.Storage/storageAccounts/listkeys/action`) on its auto-storage
 * account: Batch reads the new keys with the caller's token. The account
 * must have `autoStorage`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link SynchronizeAutoStorageKeysHttp}.
 *
 * ### Calling SynchronizeAutoStorageKeys
 * **Example:** SynchronizeAutoStorageKeys from a Function
 * ```typescript
 * // init
 * const synchronizeAutoStorageKeys = yield* Azure.Batch.SynchronizeAutoStorageKeys(account);
 *
 * // runtime
 * yield* synchronizeAutoStorageKeys();
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const synchronizeAutoStorageKeys = yield* Azure.Batch.SynchronizeAutoStorageKeys(account);
 *   // ...
 * }).pipe(Effect.provide(Azure.Batch.SynchronizeAutoStorageKeysHttp));
 * ```
 *
 * @binding
 * @category Batch
 */
export interface SynchronizeAutoStorageKeys extends Binding.Service<
  SynchronizeAutoStorageKeys,
  "Azure.Batch.SynchronizeAutoStorageKeys",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request?: SynchronizeAutoStorageKeysRequest,
    ) => Effect.Effect<
      batch.BatchAccountSynchronizeAutoStorageKeysResponse,
      batch.BatchAccountSynchronizeAutoStorageKeysError,
      RuntimeContext
    >
  >
> {}

export const SynchronizeAutoStorageKeys = Binding.Service<SynchronizeAutoStorageKeys>(
  "Azure.Batch.SynchronizeAutoStorageKeys",
);
