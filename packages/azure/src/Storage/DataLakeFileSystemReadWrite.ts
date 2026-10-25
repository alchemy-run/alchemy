import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";
import type { ReadDataLakeFileSystemClient } from "./DataLakeFileSystemRead.ts";
import type { WriteDataLakeFileSystemClient } from "./DataLakeFileSystemWrite.ts";

/** Read-write client for one Data Lake filesystem. */
export interface ReadWriteDataLakeFileSystemClient
  extends ReadDataLakeFileSystemClient, WriteDataLakeFileSystemClient {}

/**
 * Read and write access to an Azure Data Lake Storage Gen2 filesystem from
 * any host: every method of {@link DataLakeFileSystemRead} and
 * {@link DataLakeFileSystemWrite}.
 *
 * Bind it to a {@link BlobContainer} used as a Data Lake filesystem (its
 * storage account has `isHnsEnabled: true`).
 *
 * Binding assigns **Storage Blob Data Contributor** on the filesystem only:
 * read, write, delete, move, and add, which is exactly what the client
 * calls.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link DataLakeFileSystemReadWriteHttp}.
 *
 * ### Reading and Writing Files
 * **Example:** Append a line to a log file
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // Lake: an Azure.Storage.BlobContainer on an account with isHnsEnabled: true
 *     const lake = yield* Lake;
 *     const files = yield* Azure.Storage.DataLakeFileSystemReadWrite(lake);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const log = yield* files.read("logs/app.log");
 *         yield* files.write("logs/app.log", `${log?.text() ?? ""}request\n`);
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.DataLakeFileSystemReadWriteHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface DataLakeFileSystemReadWrite extends Binding.Service<
  DataLakeFileSystemReadWrite,
  "Azure.Storage.DataLakeFileSystemReadWrite",
  (fileSystem: BlobContainer) => Effect.Effect<ReadWriteDataLakeFileSystemClient>
> {}

export const DataLakeFileSystemReadWrite = Binding.Service<DataLakeFileSystemReadWrite>(
  "Azure.Storage.DataLakeFileSystemReadWrite",
);
