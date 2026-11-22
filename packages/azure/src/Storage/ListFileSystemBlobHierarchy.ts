import type * as datalake from "@distilled.cloud/azure/storage-datalake";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** The distilled request without the filesystem the binding fills in. */
export interface ListFileSystemBlobHierarchyRequest extends Omit<
  datalake.ListFileSystemBlobHierarchySegmentRequest,
  "url" | "filesystem"
> {}

/**
 * List a Data Lake filesystem through the Blob service, one level at a time
 * (`FileSystem_ListBlobHierarchySegment`). Works from any host.
 *
 * Bind it to a {@link BlobContainer} used as a Data Lake filesystem (its
 * storage account has `isHnsEnabled: true`); the callable fills in the
 * account's `blob` endpoint and the filesystem name.
 *
 * Binding assigns **Storage Blob Data Reader** on the filesystem only. Its
 * only data action is
 * `Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link ListFileSystemBlobHierarchyHttp}.
 *
 * ### Listing Blobs
 * **Example:** List the entries under a prefix
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // Lake: an Azure.Storage.BlobContainer on an account with isHnsEnabled: true
 *     const lake = yield* Lake;
 *     const listBlobs = yield* Azure.Storage.ListFileSystemBlobHierarchy(lake);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const page = yield* listBlobs({ prefix: "raw/", delimiter: "/" });
 *         const names = page.Segment.BlobItems.map((item) => item.Name);
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.ListFileSystemBlobHierarchyHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface ListFileSystemBlobHierarchy extends Binding.Service<
  ListFileSystemBlobHierarchy,
  "Azure.Storage.ListFileSystemBlobHierarchy",
  (
    fileSystem: BlobContainer,
  ) => Effect.Effect<
    (
      request: ListFileSystemBlobHierarchyRequest,
    ) => Effect.Effect<
      datalake.ListFileSystemBlobHierarchySegmentResponse,
      datalake.ListFileSystemBlobHierarchySegmentError,
      RuntimeContext
    >
  >
> {}

export const ListFileSystemBlobHierarchy = Binding.Service<ListFileSystemBlobHierarchy>(
  "Azure.Storage.ListFileSystemBlobHierarchy",
);
