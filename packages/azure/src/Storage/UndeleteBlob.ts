import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** `UndeleteBlob` request without the `url` and `containerName` the bound container supplies. */
export interface UndeleteBlobRequest extends Omit<
  blob.UndeleteBlobRequest,
  "url" | "containerName"
> {}

/**
 * Restore a soft-deleted blob and its snapshots (`Undelete Blob`). Needs
 * blob soft delete on the account (`Azure.Storage.BlobServiceProperties`
 * `deleteRetentionPolicy`). Azure checks `blobs/write` for it, not the
 * `containers/write` its docs name.
 *
 * Binding grants a custom role with only `blobs/write`, assigned on the
 * bound container only. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity; any other host gets
 * an Entra service principal with the role and its client secret in the
 * host's env (see `AzureBindings`). The custom role is an
 * `Azure.Authorization.RoleDefinition` created once per stack and shared by
 * every host. Provide {@link UndeleteBlobHttp}.
 *
 * ### Restoring Deleted Blobs
 * **Example:** Undelete a blob
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Azure.Storage.StorageAccount("Data");
 *     const files = yield* Azure.Storage.BlobContainer("Files", {
 *       storageAccount: account.storageAccountName,
 *     });
 *
 *     // init: bind the operation to the container
 *     const undeleteBlob = yield* Azure.Storage.UndeleteBlob(files);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the container's URL and name are injected
 *         yield* undeleteBlob({ blob: "hello.txt" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.UndeleteBlobHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface UndeleteBlob extends Binding.Service<
  UndeleteBlob,
  "Azure.Storage.UndeleteBlob",
  (
    container: BlobContainer,
  ) => Effect.Effect<
    (
      request: UndeleteBlobRequest,
    ) => Effect.Effect<blob.UndeleteBlobResponse, blob.UndeleteBlobError, RuntimeContext>
  >
> {}

export const UndeleteBlob = Binding.Service<UndeleteBlob>("Azure.Storage.UndeleteBlob");
