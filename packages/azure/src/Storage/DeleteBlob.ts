import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** `DeleteBlob` request without the `url` and `containerName` the bound container supplies. */
export interface DeleteBlobRequest extends Omit<blob.DeleteBlobRequest, "url" | "containerName"> {}

/**
 * Delete a blob, or one of its snapshots or versions (`Delete Blob`).
 *
 * Binding grants a custom role with only `blobs/delete`, assigned on the
 * bound container only. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity; any other host gets
 * an Entra service principal with the role and its client secret in the
 * host's env (see `AzureBindings`). The custom role is an
 * `Azure.Authorization.RoleDefinition` created once per stack and shared by
 * every host. Provide {@link DeleteBlobHttp}.
 *
 * ### Deleting Blobs
 * **Example:** Delete a blob and its snapshots
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Azure.Storage.StorageAccount("Data");
 *     const files = yield* Azure.Storage.BlobContainer("Files", {
 *       storageAccount: account.storageAccountName,
 *     });
 *
 *     // init: bind the operation to the container
 *     const deleteBlob = yield* Azure.Storage.DeleteBlob(files);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the container's URL and name are injected
 *         yield* deleteBlob({ blob: "hello.txt", xMsDeleteSnapshots: "include" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.DeleteBlobHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface DeleteBlob extends Binding.Service<
  DeleteBlob,
  "Azure.Storage.DeleteBlob",
  (
    container: BlobContainer,
  ) => Effect.Effect<
    (
      request: DeleteBlobRequest,
    ) => Effect.Effect<blob.DeleteBlobResponse, blob.DeleteBlobError, RuntimeContext>
  >
> {}

export const DeleteBlob = Binding.Service<DeleteBlob>("Azure.Storage.DeleteBlob");
