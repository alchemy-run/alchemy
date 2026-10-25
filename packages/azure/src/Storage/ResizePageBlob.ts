import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** `ResizePageBlob` request without the `url` and `containerName` the bound container supplies. */
export interface ResizePageBlobRequest extends Omit<
  blob.ResizePageBlobRequest,
  "url" | "containerName"
> {}

/**
 * Change the size of a page blob (`Set Blob Properties` with
 * `x-ms-blob-content-length`).
 *
 * Binding grants a custom role with only `blobs/write`, assigned on the
 * bound container only. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity; any other host gets
 * an Entra service principal with the role and its client secret in the
 * host's env (see `AzureBindings`). The custom role is an
 * `Azure.Authorization.RoleDefinition` created once per stack and shared by
 * every host. Provide {@link ResizePageBlobHttp}.
 *
 * ### Resizing Page Blobs
 * **Example:** Grow a page blob to 2 MiB
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
 *     const resizePageBlob = yield* Azure.Storage.ResizePageBlob(files);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the container's URL and name are injected
 *         yield* resizePageBlob({ blob: "disk.vhd", xMsBlobContentLength: 2 * 1024 * 1024 });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.ResizePageBlobHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface ResizePageBlob extends Binding.Service<
  ResizePageBlob,
  "Azure.Storage.ResizePageBlob",
  (
    container: BlobContainer,
  ) => Effect.Effect<
    (
      request: ResizePageBlobRequest,
    ) => Effect.Effect<blob.ResizePageBlobResponse, blob.ResizePageBlobError, RuntimeContext>
  >
> {}

export const ResizePageBlob = Binding.Service<ResizePageBlob>("Azure.Storage.ResizePageBlob");
