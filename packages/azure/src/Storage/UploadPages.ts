import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** `UploadPageBlobPages` request without the `url` and `containerName` the bound container supplies. */
export interface UploadPagesRequest extends Omit<
  blob.UploadPageBlobPagesRequest,
  "url" | "containerName"
> {}

/**
 * Write a 512-byte-aligned range of pages to a page blob (`Put Page`).
 *
 * Binding grants a custom role with only `blobs/write`, assigned on the
 * bound container only. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity; any other host gets
 * an Entra service principal with the role and its client secret in the
 * host's env (see `AzureBindings`). The custom role is an
 * `Azure.Authorization.RoleDefinition` created once per stack and shared by
 * every host. Provide {@link UploadPagesHttp}.
 *
 * ### Writing Pages
 * **Example:** Write the first page
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
 *     const uploadPages = yield* Azure.Storage.UploadPages(files);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the container's URL and name are injected
 *         yield* uploadPages({ blob: "disk.vhd", xMsRange: "bytes=0-511", body: page });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.UploadPagesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface UploadPages extends Binding.Service<
  UploadPages,
  "Azure.Storage.UploadPages",
  (
    container: BlobContainer,
  ) => Effect.Effect<
    (
      request: UploadPagesRequest,
    ) => Effect.Effect<
      blob.UploadPageBlobPagesResponse,
      blob.UploadPageBlobPagesError,
      RuntimeContext
    >
  >
> {}

export const UploadPages = Binding.Service<UploadPages>("Azure.Storage.UploadPages");
