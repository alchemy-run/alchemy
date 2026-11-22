import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";
import type {
  DataLakeFile,
  DataLakeFileSystemError,
  DataLakePathProperties,
  ListDataLakePathsOptions,
  ListDataLakePathsResult,
} from "./DataLakeFileSystemTypes.ts";

/** Read-only client for one Data Lake filesystem. */
export interface ReadDataLakeFileSystemClient {
  /** Read a file; `undefined` when it does not exist. */
  read(
    path: string,
  ): Effect.Effect<DataLakeFile | undefined, DataLakeFileSystemError, RuntimeContext>;
  /** Read a file's or directory's properties; `undefined` when it does not exist. */
  getProperties(
    path: string,
  ): Effect.Effect<DataLakePathProperties | undefined, DataLakeFileSystemError, RuntimeContext>;
  /** List one page of files and directories. */
  list(
    options?: ListDataLakePathsOptions,
  ): Effect.Effect<ListDataLakePathsResult, DataLakeFileSystemError, RuntimeContext>;
}

/**
 * Read access to an Azure Data Lake Storage Gen2 filesystem from any host:
 * read files, read properties, and list directories. Built on
 * {@link ReadPath}, {@link GetPathProperties}, and {@link ListPaths}.
 *
 * Bind it to a {@link BlobContainer} used as a Data Lake filesystem (its
 * storage account has `isHnsEnabled: true`).
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
 * Provide {@link DataLakeFileSystemReadHttp}.
 *
 * ### Reading Files
 * **Example:** Read a file as text
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // Lake: an Azure.Storage.BlobContainer on an account with isHnsEnabled: true
 *     const lake = yield* Lake;
 *     const files = yield* Azure.Storage.DataLakeFileSystemRead(lake);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const file = yield* files.read("reports/latest.json");
 *         return file
 *           ? HttpServerResponse.text(file.text())
 *           : HttpServerResponse.text("missing", { status: 404 });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.DataLakeFileSystemReadHttp)),
 * ) {}
 * ```
 *
 * **Example:** List a directory
 * ```typescript
 * const { paths, continuation } = yield* files.list({ directory: "reports" });
 * const names = paths.filter((p) => !p.isDirectory).map((p) => p.path);
 * ```
 *
 * @binding
 * @category Storage
 */
export interface DataLakeFileSystemRead extends Binding.Service<
  DataLakeFileSystemRead,
  "Azure.Storage.DataLakeFileSystemRead",
  (fileSystem: BlobContainer) => Effect.Effect<ReadDataLakeFileSystemClient>
> {}

export const DataLakeFileSystemRead = Binding.Service<DataLakeFileSystemRead>(
  "Azure.Storage.DataLakeFileSystemRead",
);
