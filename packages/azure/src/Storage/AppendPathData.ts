import type * as datalake from "@distilled.cloud/azure/storage-datalake";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** The distilled request without the filesystem the binding fills in. */
export interface AppendPathDataRequest extends Omit<
  datalake.PathAppendDataRequest,
  "url" | "filesystem"
> {}

/**
 * Upload bytes to a Data Lake file at a position (`Path_AppendData`); they
 * are not visible until {@link FlushPathData} commits them. Works from any
 * host.
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
 * Provide {@link AppendPathDataHttp}.
 *
 * ### Appending Data
 * **Example:** Stage a line, then flush it
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // Lake: an Azure.Storage.BlobContainer on an account with isHnsEnabled: true
 *     const lake = yield* Lake;
 *     const appendPathData = yield* Azure.Storage.AppendPathData(lake);
 *     const flushPathData = yield* Azure.Storage.FlushPathData(lake);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const line = new TextEncoder().encode("hello\n");
 *         yield* appendPathData({ path: "raw/events.log", position: 0, body: line });
 *         yield* flushPathData({ path: "raw/events.log", position: line.length });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Layer.mergeAll(Azure.Storage.AppendPathDataHttp, Azure.Storage.FlushPathDataHttp))),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface AppendPathData extends Binding.Service<
  AppendPathData,
  "Azure.Storage.AppendPathData",
  (
    fileSystem: BlobContainer,
  ) => Effect.Effect<
    (
      request: AppendPathDataRequest,
    ) => Effect.Effect<
      datalake.PathAppendDataResponse,
      datalake.PathAppendDataError,
      RuntimeContext
    >
  >
> {}

export const AppendPathData = Binding.Service<AppendPathData>("Azure.Storage.AppendPathData");
