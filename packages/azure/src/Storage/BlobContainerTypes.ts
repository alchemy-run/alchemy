import type { AzureOpError } from "@distilled.cloud/azure";

/**
 * Errors a blob container client operation can fail with: the typed
 * `@distilled.cloud/azure/storage-blob` errors, e.g.
 * `SchemaRegistryStorageAccessDenied` (`AuthorizationPermissionMismatch`)
 * while a new role assignment propagates.
 */
export type BlobContainerError = AzureOpError;

/** Properties of a blob, from `HEAD` or a list result. */
export interface BlobProperties {
  /** Blob name (its key inside the container). */
  key: string;
  /** Size in bytes. */
  size: number;
  /** `Content-Type` of the blob. */
  contentType: string | undefined;
  /** Entity tag. */
  etag: string | undefined;
  /** Last modification time, as the RFC 1123 string Azure returns. */
  lastModified: string | undefined;
}

/** A blob with its body. */
export interface BlobObject extends BlobProperties {
  /** Raw body bytes. */
  body: Uint8Array;
  /** Body decoded as UTF-8. */
  text(): string;
}

export interface ListBlobsOptions {
  /** Only return blobs whose name starts with this prefix. */
  prefix?: string;
  /** Page size (max 5000). */
  maxResults?: number;
  /** Continuation marker from a previous page's `nextMarker`. */
  marker?: string;
}

export interface ListBlobsResult {
  blobs: BlobProperties[];
  /** Pass as `marker` to fetch the next page; absent on the last page. */
  nextMarker: string | undefined;
}

/**
 * A distilled `storage-blob` request without the identifiers a bound
 * container client supplies: `url`, `containerName`, and `blob` (passed as
 * the method's `key`).
 */
export type BlobOperationRequest<R> = Omit<R, "url" | "containerName" | "blob">;

/**
 * A distilled `storage-blob` container request without the `url` and
 * `containerName` the bound container supplies.
 */
export type BlobContainerRequest<R> = Omit<R, "url" | "containerName">;

export interface PutBlobOptions {
  /** `Content-Type` stored with the blob. */
  contentType?: string;
}
