import type { AzureOpError } from "@distilled.cloud/azure";

/**
 * Errors a file share client operation can fail with: the typed
 * `@distilled.cloud/azure/storage-file` errors, e.g. `ResourceNotFound`,
 * `ParentNotFound`, `DirectoryNotEmpty`, or
 * `SchemaRegistryStorageAccessDenied` (`AuthorizationPermissionMismatch`)
 * while a new role assignment propagates.
 */
export type FileShareError = AzureOpError;

/**
 * A distilled `storage-file` request without the identifiers a bound share
 * supplies: the file endpoint `url`, the `shareName`, and the
 * `xMsFileRequestIntent: "backup"` header that Entra-token calls need.
 */
export type FileShareRequest<R> = Omit<R, "url" | "shareName" | "xMsFileRequestIntent">;

/** Properties of a file, from `HEAD` or a list result. */
export interface ShareFileProperties {
  /** Path of the file relative to the share root, e.g. `reports/q1.csv`. */
  path: string;
  /** Size in bytes. */
  size: number;
  /** `Content-Type` stored with the file. */
  contentType: string | undefined;
  /** Entity tag. */
  etag: string | undefined;
  /** Last modification time, as the RFC 1123 string Azure returns. */
  lastModified: string | undefined;
}

/** A file with its body. */
export interface ShareFile extends ShareFileProperties {
  /** Raw body bytes. */
  body: Uint8Array;
  /** Body decoded as UTF-8. */
  text(): string;
}

export interface ListShareFilesOptions {
  /**
   * Directory to list, relative to the share root.
   * @default the share root
   */
  directory?: string;
  /** Only return entries whose name starts with this prefix. */
  prefix?: string;
  /** Page size (max 5000). */
  maxResults?: number;
  /** Continuation marker from a previous page's `nextMarker`. */
  marker?: string;
}

/** One entry of a directory listing. */
export interface ShareFileEntry {
  /** Path relative to the share root, e.g. `reports/q1.csv`. */
  path: string;
  /** Size in bytes (files only). */
  size: number | undefined;
}

export interface ListShareFilesResult {
  /** Files directly in the directory. */
  files: ShareFileEntry[];
  /** Subdirectories directly in the directory, as paths relative to the share root. */
  directories: string[];
  /** Pass as `marker` to fetch the next page; absent on the last page. */
  nextMarker: string | undefined;
}

export interface PutShareFileOptions {
  /** `Content-Type` stored with the file. */
  contentType?: string;
}
