import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** `UploadPageBlobPagesFromURL` request without the `url` and `containerName` the bound container supplies. */
export interface UploadPagesFromUrlRequest extends Omit<
  blob.UploadPageBlobPagesFromURLRequest,
  "url" | "containerName"
> {}

/**
 * Write a range of pages whose content is read from a URL (`Put Page From
 * URL`).
 *
 * Binding grants a custom role with only `blobs/write` (Azure reads the
 * source with the URL's own authorization: public, a SAS, or
 * `xMsCopySourceAuthorization`), assigned on the bound container only. On a
 * host with a managed identity (an Azure Function, Function App, Web App,
 * Container App, container group, VM, or AKS workload identity) the role
 * goes to that identity; any other host gets an Entra service principal with
 * the role and its client secret in the host's env (see `AzureBindings`).
 * The custom role is an `Azure.Authorization.RoleDefinition` created once
 * per stack and shared by every host. Provide {@link
 * UploadPagesFromUrlHttp}.
 *
 * ### Writing Pages From a URL
 * **Example:** Copy the first page from a URL
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
 *     const uploadPagesFromUrl = yield* Azure.Storage.UploadPagesFromUrl(files);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the container's URL and name are injected
 *         yield* uploadPagesFromUrl({
 *           blob: "disk.vhd",
 *           xMsCopySource: sourceUrl,
 *           xMsSourceRange: "bytes=0-511",
 *           xMsRange: "bytes=0-511",
 *         });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.UploadPagesFromUrlHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface UploadPagesFromUrl extends Binding.Service<
  UploadPagesFromUrl,
  "Azure.Storage.UploadPagesFromUrl",
  (
    container: BlobContainer,
  ) => Effect.Effect<
    (
      request: UploadPagesFromUrlRequest,
    ) => Effect.Effect<
      blob.UploadPageBlobPagesFromURLResponse,
      blob.UploadPageBlobPagesFromURLError,
      RuntimeContext
    >
  >
> {}

export const UploadPagesFromUrl = Binding.Service<UploadPagesFromUrl>(
  "Azure.Storage.UploadPagesFromUrl",
);
