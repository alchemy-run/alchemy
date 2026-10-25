import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";
import type {
  BlobContainerError,
  BlobContainerRequest,
  BlobOperationRequest,
  PutBlobOptions,
} from "./BlobContainerTypes.ts";

/** A per-blob write method over one distilled operation. */
type BlobMethod<Req, Res> = (
  key: string,
  options: BlobOperationRequest<Req>,
) => Effect.Effect<Res, BlobContainerError, RuntimeContext>;

/** A per-blob write method whose options are all optional. */
type OptionalBlobMethod<Req, Res> = (
  key: string,
  options?: BlobOperationRequest<Req>,
) => Effect.Effect<Res, BlobContainerError, RuntimeContext>;

/** Write-only client for one blob container. */
export interface WriteBlobContainerClient {
  /** Upload (create or overwrite) a block blob. */
  put(
    key: string,
    body: string | Uint8Array,
    options?: PutBlobOptions,
  ): Effect.Effect<{ etag: string | undefined }, BlobContainerError, RuntimeContext>;
  /** Delete a blob; succeeds when it is already gone. */
  delete(key: string): Effect.Effect<void, BlobContainerError, RuntimeContext>;
  /** Upload one uncommitted block of a block blob. */
  stageBlock: BlobMethod<blob.BlockBlobStageBlockRequest, blob.BlockBlobStageBlockResponse>;
  /** Commit a list of staged blocks as the blob's content. */
  commitBlockList: OptionalBlobMethod<
    blob.ListBlockBlobCommitBlockRequest,
    blob.ListBlockBlobCommitBlockResponse
  >;
  /** Create an empty append blob. */
  createAppendBlob: OptionalBlobMethod<blob.CreateAppendBlobRequest, blob.CreateAppendBlobResponse>;
  /** Append a block to an append blob. */
  appendBlock: BlobMethod<blob.BlockAppendBlobAppendRequest, blob.BlockAppendBlobAppendResponse>;
  /** Seal an append blob (make it read-only). */
  sealAppendBlob: OptionalBlobMethod<blob.SealAppendBlobRequest, blob.SealAppendBlobResponse>;
  /** Create a page blob of `xMsBlobContentLength` bytes. */
  createPageBlob: BlobMethod<blob.CreatePageBlobRequest, blob.CreatePageBlobResponse>;
  /** Write a range of pages. */
  uploadPages: BlobMethod<blob.UploadPageBlobPagesRequest, blob.UploadPageBlobPagesResponse>;
  /** Clear a range of pages. */
  clearPages: OptionalBlobMethod<blob.ClearPageBlobPagesRequest, blob.ClearPageBlobPagesResponse>;
  /** Resize a page blob. */
  resizePageBlob: BlobMethod<blob.ResizePageBlobRequest, blob.ResizePageBlobResponse>;
  /** Set or increment a page blob's sequence number. */
  updateSequenceNumber: BlobMethod<
    blob.UpdatePageBlobSequenceNumberRequest,
    blob.UpdatePageBlobSequenceNumberResponse
  >;
  /** Set a blob's HTTP headers (`Content-Type`, `Cache-Control`, …). */
  setHttpHeaders: OptionalBlobMethod<
    blob.SetBlobHTTPHeadersRequest,
    blob.SetBlobHTTPHeadersResponse
  >;
  /** Replace a blob's user metadata. */
  setMetadata: OptionalBlobMethod<blob.SetBlobMetadataRequest, blob.SetBlobMetadataResponse>;
  /** Move a blob to the Hot, Cool, Cold, or Archive tier. */
  setTier: BlobMethod<blob.SetBlobTierRequest, blob.SetBlobTierResponse>;
  /** Create a read-only snapshot of a blob. */
  createSnapshot: OptionalBlobMethod<
    blob.CreateBlobSnapshotRequest,
    blob.CreateBlobSnapshotResponse
  >;
  /** Acquire a lease on a blob. */
  acquireLease: OptionalBlobMethod<blob.BlobAcquireLeaseRequest, blob.BlobAcquireLeaseResponse>;
  /** Release a blob lease. */
  releaseLease: BlobMethod<blob.BlobReleaseLeaseRequest, blob.BlobReleaseLeaseResponse>;
  /** Renew a blob lease. */
  renewLease: BlobMethod<blob.RenewBlobLeaseRequest, blob.RenewBlobLeaseResponse>;
  /** Change a blob lease's ID. */
  changeLease: BlobMethod<blob.BlobChangeLeaseRequest, blob.BlobChangeLeaseResponse>;
  /** Break a blob lease. */
  breakLease: OptionalBlobMethod<blob.BlobBreakLeaseRequest, blob.BlobBreakLeaseResponse>;
  /** Start an asynchronous copy into this blob. */
  startCopy: BlobMethod<blob.BlobStartCopyFromURLRequest, blob.BlobStartCopyFromURLResponse>;
  /** Copy a blob (up to 256 MiB) from a URL synchronously. */
  copyFromUrl: BlobMethod<blob.CopyBlobFromURLRequest, blob.CopyBlobFromURLResponse>;
  /** Create a block blob from a URL's content. */
  putFromUrl: BlobMethod<blob.PutBlockBlobBlobFromUrlRequest, blob.PutBlockBlobBlobFromUrlResponse>;
  /** Abort a pending copy. */
  abortCopy: BlobMethod<blob.BlobAbortCopyFromURLRequest, blob.BlobAbortCopyFromURLResponse>;
  /** Restore a soft-deleted blob (needs blob soft delete on the account). */
  undelete: OptionalBlobMethod<blob.UndeleteBlobRequest, blob.UndeleteBlobResponse>;
  /** Replace the container's user metadata. */
  setContainerMetadata(
    options?: BlobContainerRequest<blob.SetContainerMetadataRequest>,
  ): Effect.Effect<blob.SetContainerMetadataResponse, BlobContainerError, RuntimeContext>;
}

/**
 * Write access to an Azure Storage blob container from any host.
 *
 * Binding assigns **Storage Blob Data Contributor** on the container only
 * (Azure has no write-only blob role). The client covers every block,
 * append, and page blob write, leases, copies, tiers, snapshots, metadata,
 * and undelete. Blob index tags, container access policies, and
 * immutability policies need their per-operation bindings (`SetBlobTags`,
 * `SetContainerAccessPolicy`, `SetBlobImmutabilityPolicy`, …): Contributor
 * does not grant them.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link BlobContainerWriteHttp}.
 *
 * ### Writing Blobs
 * **Example:** Upload JSON
 * ```typescript
 * // init
 * const files = yield* Azure.Storage.BlobContainerWrite(container);
 *
 * // runtime
 * yield* files.put("reports/latest.json", JSON.stringify(report), {
 *   contentType: "application/json",
 * });
 * ```
 *
 * **Example:** Delete a blob
 * ```typescript
 * yield* files.delete("reports/stale.json");
 * ```
 *
 * ### Uploading in Blocks
 * **Example:** Stage two blocks and commit them
 * ```typescript
 * const id = (n: number) => btoa(`block-${n}`);
 * yield* files.stageBlock("big.bin", { blockid: id(0), body: part0 });
 * yield* files.stageBlock("big.bin", { blockid: id(1), body: part1 });
 * yield* files.commitBlockList("big.bin", { Latest: [id(0), id(1)] });
 * ```
 *
 * @binding
 * @category Storage
 */
export interface BlobContainerWrite extends Binding.Service<
  BlobContainerWrite,
  "Azure.Storage.BlobContainerWrite",
  (container: BlobContainer) => Effect.Effect<WriteBlobContainerClient>
> {}

export const BlobContainerWrite = Binding.Service<BlobContainerWrite>(
  "Azure.Storage.BlobContainerWrite",
);
