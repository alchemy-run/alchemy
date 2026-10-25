import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** `DownloadBlob` request without the `url` and `containerName` the bound container supplies. */
export interface DownloadBlobRequest extends Omit<
  blob.DownloadBlobRequest,
  "url" | "containerName"
> {}

/**
 * Download a blob's content, metadata, and properties (`Get Blob`).
 *
 * Binding grants **Storage Blob Data Reader** (`blobs/read`), assigned on
 * the bound container only. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity; any other host gets
 * an Entra service principal with the role and its client secret in the
 * host's env (see `AzureBindings`). Provide {@link DownloadBlobHttp}.
 *
 * ### Downloading Blobs
 * **Example:** Download a blob as text
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
 *     const downloadBlob = yield* Azure.Storage.DownloadBlob(files);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the container's URL and name are injected
 *         const res = yield* downloadBlob({ blob: "hello.txt" });
 *         const text = new TextDecoder().decode(res.body);
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.DownloadBlobHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface DownloadBlob extends Binding.Service<
  DownloadBlob,
  "Azure.Storage.DownloadBlob",
  (
    container: BlobContainer,
  ) => Effect.Effect<
    (
      request: DownloadBlobRequest,
    ) => Effect.Effect<blob.DownloadBlobResponse, blob.DownloadBlobError, RuntimeContext>
  >
> {}

export const DownloadBlob = Binding.Service<DownloadBlob>("Azure.Storage.DownloadBlob");
