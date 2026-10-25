import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** `PutBlockBlobBlobFromUrl` request without the `url` and `containerName` the bound container supplies. */
export interface PutBlobFromUrlRequest extends Omit<
  blob.PutBlockBlobBlobFromUrlRequest,
  "url" | "containerName"
> {}

/**
 * Create a block blob from the content at a URL (`Put Blob From URL`).
 *
 * Binding grants a custom role with only `blobs/write` (Azure reads the
 * source with the URL's own authorization: public, a SAS, or
 * `xMsCopySourceAuthorization`), assigned on the bound container only. On a
 * host with a managed identity (an Azure Function, Function App, Web App,
 * Container App, container group, VM, or AKS workload identity) the role
 * goes to that identity; any other host gets an Entra service principal with
 * the role and its client secret in the host's env (see `AzureBindings`).
 * The custom role is an `Azure.Authorization.RoleDefinition` created once
 * per stack and shared by every host. Provide {@link PutBlobFromUrlHttp}.
 *
 * ### Uploading From a URL
 * **Example:** Import a public file
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
 *     const putBlobFromUrl = yield* Azure.Storage.PutBlobFromUrl(files);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the container's URL and name are injected
 *         yield* putBlobFromUrl({ blob: "import.txt", xMsCopySource: "https://example.com/file.txt" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.PutBlobFromUrlHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface PutBlobFromUrl extends Binding.Service<
  PutBlobFromUrl,
  "Azure.Storage.PutBlobFromUrl",
  (
    container: BlobContainer,
  ) => Effect.Effect<
    (
      request: PutBlobFromUrlRequest,
    ) => Effect.Effect<
      blob.PutBlockBlobBlobFromUrlResponse,
      blob.PutBlockBlobBlobFromUrlError,
      RuntimeContext
    >
  >
> {}

export const PutBlobFromUrl = Binding.Service<PutBlobFromUrl>("Azure.Storage.PutBlobFromUrl");
