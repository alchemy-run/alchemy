import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** `UploadBlockBlob` request without the `url` and `containerName` the bound container supplies. */
export interface UploadBlockBlobRequest extends Omit<
  blob.UploadBlockBlobRequest,
  "url" | "containerName"
> {}

/**
 * Create or overwrite a block blob in one request (`Put Blob`).
 *
 * Binding grants a custom role with only `blobs/write`, assigned on the
 * bound container only. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity; any other host gets
 * an Entra service principal with the role and its client secret in the
 * host's env (see `AzureBindings`). The custom role is an
 * `Azure.Authorization.RoleDefinition` created once per stack and shared by
 * every host. Provide {@link UploadBlockBlobHttp}.
 *
 * ### Uploading Blobs
 * **Example:** Upload text
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
 *     const uploadBlockBlob = yield* Azure.Storage.UploadBlockBlob(files);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the container's URL and name are injected
 *         yield* uploadBlockBlob({
 *           blob: "hello.txt",
 *           body: new TextEncoder().encode("hello"),
 *           xMsBlobContentType: "text/plain",
 *         });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.UploadBlockBlobHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface UploadBlockBlob extends Binding.Service<
  UploadBlockBlob,
  "Azure.Storage.UploadBlockBlob",
  (
    container: BlobContainer,
  ) => Effect.Effect<
    (
      request: UploadBlockBlobRequest,
    ) => Effect.Effect<blob.UploadBlockBlobResponse, blob.UploadBlockBlobError, RuntimeContext>
  >
> {}

export const UploadBlockBlob = Binding.Service<UploadBlockBlob>("Azure.Storage.UploadBlockBlob");
