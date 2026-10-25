import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** `ListContainerBlobHierarchySegment` request without the `url` and `containerName` the bound container supplies. */
export interface ListBlobsByHierarchyRequest extends Omit<
  blob.ListContainerBlobHierarchySegmentRequest,
  "url" | "containerName"
> {}

/**
 * List one page of the container's blobs grouped by a delimiter, as virtual
 * directories (`List Blobs` with `delimiter`).
 *
 * Binding grants **Storage Blob Data Reader** (`blobs/read`), assigned on
 * the bound container only. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity; any other host gets
 * an Entra service principal with the role and its client secret in the
 * host's env (see `AzureBindings`). Provide {@link
 * ListBlobsByHierarchyHttp}.
 *
 * ### Listing Virtual Directories
 * **Example:** List the top-level directories
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
 *     const listBlobsByHierarchy = yield* Azure.Storage.ListBlobsByHierarchy(files);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the container's URL and name are injected
 *         const page = yield* listBlobsByHierarchy({ delimiter: "/" });
 *         const dirs = (page.Segment?.BlobPrefixes ?? []).map((p) => p.Name?.content);
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.ListBlobsByHierarchyHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface ListBlobsByHierarchy extends Binding.Service<
  ListBlobsByHierarchy,
  "Azure.Storage.ListBlobsByHierarchy",
  (
    container: BlobContainer,
  ) => Effect.Effect<
    (
      request: ListBlobsByHierarchyRequest,
    ) => Effect.Effect<
      blob.ListContainerBlobHierarchySegmentResponse,
      blob.ListContainerBlobHierarchySegmentError,
      RuntimeContext
    >
  >
> {}

export const ListBlobsByHierarchy = Binding.Service<ListBlobsByHierarchy>(
  "Azure.Storage.ListBlobsByHierarchy",
);
