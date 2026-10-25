import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { StorageAccount } from "./StorageAccount.ts";

/** `RestoreContainer` request without the `url` the bound account supplies. */
export interface RestoreBlobContainerRequest extends Omit<blob.RestoreContainerRequest, "url"> {}

/**
 * Restore a soft-deleted blob container (`Restore Container`). Needs
 * container soft delete on the account
 * (`Azure.Storage.BlobServiceProperties` `containerDeleteRetentionPolicy`).
 *
 * Binding grants a custom role with only `containers/write`, assigned on the
 * bound storage account (an account-level operation has no narrower scope).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host gets an Entra service principal
 * with the role and its client secret in the host's env (see
 * `AzureBindings`). The custom role is an
 * `Azure.Authorization.RoleDefinition` created once per stack and shared by
 * every host. Provide {@link RestoreBlobContainerHttp}.
 *
 * ### Restoring Containers
 * **Example:** Restore a deleted container
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Azure.Storage.StorageAccount("Data");
 *
 *     // init: bind the operation to the account
 *     const restoreBlobContainer = yield* Azure.Storage.RestoreBlobContainer(account);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the account's Blob endpoint is injected
 *         yield* restoreBlobContainer({
 *           containerName: "reports",
 *           xMsDeletedContainerName: "reports",
 *           xMsDeletedContainerVersion: version,
 *         });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.RestoreBlobContainerHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface RestoreBlobContainer extends Binding.Service<
  RestoreBlobContainer,
  "Azure.Storage.RestoreBlobContainer",
  (
    account: StorageAccount,
  ) => Effect.Effect<
    (
      request: RestoreBlobContainerRequest,
    ) => Effect.Effect<blob.RestoreContainerResponse, blob.RestoreContainerError, RuntimeContext>
  >
> {}

export const RestoreBlobContainer = Binding.Service<RestoreBlobContainer>(
  "Azure.Storage.RestoreBlobContainer",
);
