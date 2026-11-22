import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { StorageAccount } from "./StorageAccount.ts";

/** `DeleteContainer` request without the `url` the bound account supplies. */
export interface DeleteBlobContainerRequest extends Omit<blob.DeleteContainerRequest, "url"> {}

/**
 * Delete a blob container and every blob in it (`Delete Container`).
 *
 * Binding grants a custom role with only `containers/delete`, assigned on
 * the bound storage account (an account-level operation has no narrower
 * scope). On a host with a managed identity (an Azure Function, Function
 * App, Web App, Container App, container group, VM, or AKS workload
 * identity) the role goes to that identity; any other host gets an Entra
 * service principal with the role and its client secret in the host's env
 * (see `AzureBindings`). The custom role is an
 * `Azure.Authorization.RoleDefinition` created once per stack and shared by
 * every host. Provide {@link DeleteBlobContainerHttp}.
 *
 * ### Deleting Containers
 * **Example:** Delete a tenant's container
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Azure.Storage.StorageAccount("Data");
 *
 *     // init: bind the operation to the account
 *     const deleteBlobContainer = yield* Azure.Storage.DeleteBlobContainer(account);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the account's Blob endpoint is injected
 *         yield* deleteBlobContainer({ containerName: `tenant-${tenantId}` });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.DeleteBlobContainerHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface DeleteBlobContainer extends Binding.Service<
  DeleteBlobContainer,
  "Azure.Storage.DeleteBlobContainer",
  (
    account: StorageAccount,
  ) => Effect.Effect<
    (
      request: DeleteBlobContainerRequest,
    ) => Effect.Effect<blob.DeleteContainerResponse, blob.DeleteContainerError, RuntimeContext>
  >
> {}

export const DeleteBlobContainer = Binding.Service<DeleteBlobContainer>(
  "Azure.Storage.DeleteBlobContainer",
);
