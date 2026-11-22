import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** `SetBlobHTTPHeaders` request without the `url` and `containerName` the bound container supplies. */
export interface SetBlobHTTPHeadersRequest extends Omit<
  blob.SetBlobHTTPHeadersRequest,
  "url" | "containerName"
> {}

/**
 * Set a blob's HTTP headers: content type, encoding, language, disposition,
 * cache control, and MD5 (`Set Blob Properties`).
 *
 * Binding grants a custom role with only `blobs/write`, assigned on the
 * bound container only. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity; any other host gets
 * an Entra service principal with the role and its client secret in the
 * host's env (see `AzureBindings`). The custom role is an
 * `Azure.Authorization.RoleDefinition` created once per stack and shared by
 * every host. Provide {@link SetBlobHTTPHeadersHttp}.
 *
 * ### Setting HTTP Headers
 * **Example:** Set content type and caching
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
 *     const setBlobHTTPHeaders = yield* Azure.Storage.SetBlobHTTPHeaders(files);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the container's URL and name are injected
 *         yield* setBlobHTTPHeaders({
 *           blob: "site/index.html",
 *           xMsBlobContentType: "text/html",
 *           xMsBlobCacheControl: "max-age=60",
 *         });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.SetBlobHTTPHeadersHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface SetBlobHTTPHeaders extends Binding.Service<
  SetBlobHTTPHeaders,
  "Azure.Storage.SetBlobHTTPHeaders",
  (
    container: BlobContainer,
  ) => Effect.Effect<
    (
      request: SetBlobHTTPHeadersRequest,
    ) => Effect.Effect<
      blob.SetBlobHTTPHeadersResponse,
      blob.SetBlobHTTPHeadersError,
      RuntimeContext
    >
  >
> {}

export const SetBlobHTTPHeaders = Binding.Service<SetBlobHTTPHeaders>(
  "Azure.Storage.SetBlobHTTPHeaders",
);
