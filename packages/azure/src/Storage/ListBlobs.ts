import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** `ListContainerBlobFlatSegment` request without the `url` and `containerName` the bound container supplies. */
export interface ListBlobsRequest extends Omit<
  blob.ListContainerBlobFlatSegmentRequest,
  "url" | "containerName"
> {}

/**
 * List one page of the container's blobs (`List Blobs`).
 *
 * Binding grants **Storage Blob Data Reader** (`blobs/read`), assigned on
 * the bound container only. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity; any other host gets
 * an Entra service principal with the role and its client secret in the
 * host's env (see `AzureBindings`). Provide {@link ListBlobsHttp}.
 *
 * ### Listing Blobs
 * **Example:** List blobs under a prefix
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
 *     const listBlobs = yield* Azure.Storage.ListBlobs(files);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the container's URL and name are injected
 *         const page = yield* listBlobs({ prefix: "reports/", maxresults: 100 });
 *         const names = (page.Segment?.BlobItems ?? []).map((b) => b.Name?.content);
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.ListBlobsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface ListBlobs extends Binding.Service<
  ListBlobs,
  "Azure.Storage.ListBlobs",
  (
    container: BlobContainer,
  ) => Effect.Effect<
    (
      request?: ListBlobsRequest,
    ) => Effect.Effect<
      blob.ListContainerBlobFlatSegmentResponse,
      blob.ListContainerBlobFlatSegmentError,
      RuntimeContext
    >
  >
> {}

export const ListBlobs = Binding.Service<ListBlobs>("Azure.Storage.ListBlobs");
