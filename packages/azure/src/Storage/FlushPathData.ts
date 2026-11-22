import type * as datalake from "@distilled.cloud/azure/storage-datalake";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** The distilled request without the filesystem the binding fills in. */
export interface FlushPathDataRequest extends Omit<
  datalake.FlushPathDataRequest,
  "url" | "filesystem"
> {}

/**
 * Commit data staged with {@link AppendPathData} to a Data Lake file
 * (`Path_FlushData`); `position` is the file's length after the flush. Works
 * from any host.
 *
 * Bind it to a {@link BlobContainer} used as a Data Lake filesystem (its
 * storage account has `isHnsEnabled: true`); the callable fills in the
 * account's `dfs` endpoint and the filesystem name.
 *
 * Binding assigns a custom role with exactly
 * `Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write` on
 * the filesystem only. Storage Blob Data Contributor would also grant read
 * and delete, so the role is the `Azure.Authorization.RoleDefinition`
 * `DataLakePathWriteRole`, defined once per stack at the subscription and
 * shared by every host that binds it.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link FlushPathDataHttp}.
 *
 * ### Flushing Data
 * **Example:** Commit staged bytes and close the file
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // Lake: an Azure.Storage.BlobContainer on an account with isHnsEnabled: true
 *     const lake = yield* Lake;
 *     const flushPathData = yield* Azure.Storage.FlushPathData(lake);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* flushPathData({ path: "raw/events.log", position: 6, close: true });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.FlushPathDataHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface FlushPathData extends Binding.Service<
  FlushPathData,
  "Azure.Storage.FlushPathData",
  (
    fileSystem: BlobContainer,
  ) => Effect.Effect<
    (
      request: FlushPathDataRequest,
    ) => Effect.Effect<datalake.FlushPathDataResponse, datalake.FlushPathDataError, RuntimeContext>
  >
> {}

export const FlushPathData = Binding.Service<FlushPathData>("Azure.Storage.FlushPathData");
