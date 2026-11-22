import type * as datalake from "@distilled.cloud/azure/storage-datalake";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** The distilled request without the filesystem the binding fills in. */
export interface UndeletePathRequest extends Omit<
  datalake.UndeletePathRequest,
  "url" | "filesystem"
> {}

/**
 * Restore a soft-deleted Data Lake path (`Path_Undelete`); the account's
 * Blob service needs a `deleteRetentionPolicy`. Works from any host.
 *
 * Bind it to a {@link BlobContainer} used as a Data Lake filesystem (its
 * storage account has `isHnsEnabled: true`); the callable fills in the
 * account's `blob` endpoint and the filesystem name.
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
 * Provide {@link UndeletePathHttp}.
 *
 * ### Restoring Paths
 * **Example:** Restore a file deleted a moment ago
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // Lake: an Azure.Storage.BlobContainer on an account with isHnsEnabled: true
 *     const lake = yield* Lake;
 *     const undeletePath = yield* Azure.Storage.UndeletePath(lake);
 *     const deletePath = yield* Azure.Storage.DeletePath(lake);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { xMsDeletionId } = yield* deletePath({ path: "raw/a.txt" });
 *         yield* undeletePath({
 *           path: "raw/a.txt",
 *           xMsUndeleteSource: `raw/a.txt?deletionid=${xMsDeletionId}`,
 *         });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Layer.mergeAll(Azure.Storage.UndeletePathHttp, Azure.Storage.DeletePathHttp))),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface UndeletePath extends Binding.Service<
  UndeletePath,
  "Azure.Storage.UndeletePath",
  (
    fileSystem: BlobContainer,
  ) => Effect.Effect<
    (
      request: UndeletePathRequest,
    ) => Effect.Effect<datalake.UndeletePathResponse, datalake.UndeletePathError, RuntimeContext>
  >
> {}

export const UndeletePath = Binding.Service<UndeletePath>("Azure.Storage.UndeletePath");
