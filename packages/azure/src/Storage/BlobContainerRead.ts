import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";
import type {
  BlobContainerError,
  BlobContainerRequest,
  BlobObject,
  BlobOperationRequest,
  BlobProperties,
  ListBlobsOptions,
  ListBlobsResult,
} from "./BlobContainerTypes.ts";

/** Read-only client for one blob container. */
export interface ReadBlobContainerClient {
  /** Download a blob; `undefined` when it does not exist. */
  get(key: string): Effect.Effect<BlobObject | undefined, BlobContainerError, RuntimeContext>;
  /** Read a blob's properties; `undefined` when it does not exist. */
  head(key: string): Effect.Effect<BlobProperties | undefined, BlobContainerError, RuntimeContext>;
  /** List one page of blobs. */
  list(
    options?: ListBlobsOptions,
  ): Effect.Effect<ListBlobsResult, BlobContainerError, RuntimeContext>;
  /** List one page of blobs grouped by a `delimiter` (virtual directories). */
  listByHierarchy(
    options: BlobContainerRequest<blob.ListContainerBlobHierarchySegmentRequest>,
  ): Effect.Effect<
    blob.ListContainerBlobHierarchySegmentResponse,
    BlobContainerError,
    RuntimeContext
  >;
  /** List a block blob's committed and/or uncommitted blocks. */
  getBlockList(
    key: string,
    options: BlobOperationRequest<blob.BlockBlobGetBlockListRequest>,
  ): Effect.Effect<blob.BlockBlobGetBlockListResponse, BlobContainerError, RuntimeContext>;
  /** List a page blob's valid page ranges. */
  getPageRanges(
    key: string,
    options?: BlobOperationRequest<blob.GetPageBlobPageRangesRequest>,
  ): Effect.Effect<blob.GetPageBlobPageRangesResponse, BlobContainerError, RuntimeContext>;
  /** List the page ranges that changed since a snapshot. */
  getPageRangesDiff(
    key: string,
    options?: BlobOperationRequest<blob.GetPageBlobPageRangesDiffRequest>,
  ): Effect.Effect<blob.GetPageBlobPageRangesDiffResponse, BlobContainerError, RuntimeContext>;
  /** Run a SQL query over a CSV/JSON/Parquet blob. */
  query(
    key: string,
    options: BlobOperationRequest<blob.BlobQueryRequest>,
  ): Effect.Effect<blob.BlobQueryResponse, BlobContainerError, RuntimeContext>;
  /** Read the container's metadata and system properties. */
  getContainerProperties(
    options?: BlobContainerRequest<blob.GetContainerPropertiesRequest>,
  ): Effect.Effect<blob.GetContainerPropertiesResponse, BlobContainerError, RuntimeContext>;
}

/**
 * Read access to an Azure Storage blob container from any host.
 *
 * Binding assigns **Storage Blob Data Reader** on the container only. The
 * client covers downloads, properties, flat and hierarchical listings,
 * block lists, page ranges, blob queries, and container properties.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link BlobContainerReadHttp}.
 *
 * ### Reading Blobs
 * **Example:** Read a blob as text
 * ```typescript
 * // init
 * const files = yield* Azure.Storage.BlobContainerRead(container);
 *
 * // runtime
 * const blob = yield* files.get("reports/latest.json");
 * const report = blob ? JSON.parse(blob.text()) : undefined;
 * ```
 *
 * **Example:** List blobs under a prefix
 * ```typescript
 * const { blobs, nextMarker } = yield* files.list({ prefix: "reports/" });
 * ```
 *
 * @binding
 * @category Storage
 */
export interface BlobContainerRead extends Binding.Service<
  BlobContainerRead,
  "Azure.Storage.BlobContainerRead",
  (container: BlobContainer) => Effect.Effect<ReadBlobContainerClient>
> {}

export const BlobContainerRead = Binding.Service<BlobContainerRead>(
  "Azure.Storage.BlobContainerRead",
);
