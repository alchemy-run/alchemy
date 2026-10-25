import type { AzureOpError } from "@distilled.cloud/azure";

/**
 * Errors a Data Lake filesystem client operation can fail with: the typed
 * `@distilled.cloud/azure/storage-datalake` errors, e.g.
 * `SchemaRegistryStorageAccessDenied` (`AuthorizationPermissionMismatch`)
 * while a new role assignment propagates, or `DirectoryNotEmpty`.
 */
export type DataLakeFileSystemError = AzureOpError;

/** A file or directory, from `HEAD` or a listing. */
export interface DataLakePathInfo {
  /** Path relative to the filesystem root, e.g. `raw/2026/events.log`. */
  path: string;
  /** Whether the path is a directory. */
  isDirectory: boolean;
  /** Size in bytes (`0` for a directory). */
  size: number;
  /** Entity tag. */
  etag: string | undefined;
  /** Last modification time, as the RFC 1123 string Azure returns. */
  lastModified: string | undefined;
  /** Owner (an Entra object ID, or `$superuser`). */
  owner: string | undefined;
  /** Owning group. */
  group: string | undefined;
  /** POSIX permissions, e.g. `rwxr-x---`. */
  permissions: string | undefined;
}

/** A file's properties, from `HEAD`. */
export interface DataLakePathProperties extends DataLakePathInfo {
  /** `Content-Type` of the file. */
  contentType: string | undefined;
}

/** A file with its body. */
export interface DataLakeFile {
  /** Path relative to the filesystem root. */
  path: string;
  /** Size in bytes. */
  size: number;
  /** `Content-Type` of the file. */
  contentType: string | undefined;
  /** Entity tag. */
  etag: string | undefined;
  /** Last modification time, as the RFC 1123 string Azure returns. */
  lastModified: string | undefined;
  /** Raw body bytes. */
  body: Uint8Array;
  /** Body decoded as UTF-8. */
  text(): string;
}

export interface ListDataLakePathsOptions {
  /** Only list this directory. @default the filesystem root */
  directory?: string;
  /** List every level below `directory`. @default false */
  recursive?: boolean;
  /** Page size (max 5000). */
  maxResults?: number;
  /** Continuation token from a previous page's `continuation`. */
  continuation?: string;
}

export interface ListDataLakePathsResult {
  paths: DataLakePathInfo[];
  /** Pass as `continuation` to fetch the next page; absent on the last page. */
  continuation: string | undefined;
}

export interface WriteDataLakeFileOptions {
  /** `Content-Type` stored with the file. */
  contentType?: string;
}

export interface DeleteDataLakePathOptions {
  /** Delete a directory and everything in it. @default false */
  recursive?: boolean;
}
