import type * as datalake from "@distilled.cloud/azure/storage-datalake";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** The distilled request without the filesystem the binding fills in. */
export interface SetPathExpiryRequest extends Omit<
  datalake.SetPathExpiryRequest,
  "url" | "filesystem"
> {}

/**
 * Set when a Data Lake file expires and is deleted (`Path_SetExpiry`). Works
 * from any host.
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
 * Provide {@link SetPathExpiryHttp}.
 *
 * ### Expiring Files
 * **Example:** Delete a file in one day
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // Lake: an Azure.Storage.BlobContainer on an account with isHnsEnabled: true
 *     const lake = yield* Lake;
 *     const setPathExpiry = yield* Azure.Storage.SetPathExpiry(lake);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* setPathExpiry({
 *           path: "tmp/upload.bin",
 *           xMsExpiryOption: "RelativeToNow",
 *           xMsExpiryTime: String(24 * 60 * 60 * 1000),
 *         });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.SetPathExpiryHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface SetPathExpiry extends Binding.Service<
  SetPathExpiry,
  "Azure.Storage.SetPathExpiry",
  (
    fileSystem: BlobContainer,
  ) => Effect.Effect<
    (
      request: SetPathExpiryRequest,
    ) => Effect.Effect<datalake.SetPathExpiryResponse, datalake.SetPathExpiryError, RuntimeContext>
  >
> {}

export const SetPathExpiry = Binding.Service<SetPathExpiry>("Azure.Storage.SetPathExpiry");
