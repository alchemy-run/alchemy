import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** `BlobAbortCopyFromURL` request without the `url` and `containerName` the bound container supplies. */
export interface AbortCopyBlobRequest extends Omit<
  blob.BlobAbortCopyFromURLRequest,
  "url" | "containerName"
> {}

/**
 * Abort a pending copy and leave a zero-length destination blob (`Abort Copy
 * Blob`).
 *
 * Binding grants a custom role with only `blobs/write`, assigned on the
 * bound container only. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity; any other host gets
 * an Entra service principal with the role and its client secret in the
 * host's env (see `AzureBindings`). The custom role is an
 * `Azure.Authorization.RoleDefinition` created once per stack and shared by
 * every host. Provide {@link AbortCopyBlobHttp}.
 *
 * ### Aborting Copies
 * **Example:** Abort a pending copy
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
 *     const abortCopyBlob = yield* Azure.Storage.AbortCopyBlob(files);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the container's URL and name are injected
 *         yield* abortCopyBlob({ blob: "copy.bin", copyid: copyId });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.AbortCopyBlobHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface AbortCopyBlob extends Binding.Service<
  AbortCopyBlob,
  "Azure.Storage.AbortCopyBlob",
  (
    container: BlobContainer,
  ) => Effect.Effect<
    (
      request: AbortCopyBlobRequest,
    ) => Effect.Effect<
      blob.BlobAbortCopyFromURLResponse,
      blob.BlobAbortCopyFromURLError,
      RuntimeContext
    >
  >
> {}

export const AbortCopyBlob = Binding.Service<AbortCopyBlob>("Azure.Storage.AbortCopyBlob");
