import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** `CreatePageBlob` request without the `url` and `containerName` the bound container supplies. */
export interface CreatePageBlobRequest extends Omit<
  blob.CreatePageBlobRequest,
  "url" | "containerName"
> {}

/**
 * Create a page blob of a fixed size, a multiple of 512 bytes (`Put Blob`
 * with `x-ms-blob-type: PageBlob`).
 *
 * Binding grants a custom role with only `blobs/write`, assigned on the
 * bound container only. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity; any other host gets
 * an Entra service principal with the role and its client secret in the
 * host's env (see `AzureBindings`). The custom role is an
 * `Azure.Authorization.RoleDefinition` created once per stack and shared by
 * every host. Provide {@link CreatePageBlobHttp}.
 *
 * ### Creating Page Blobs
 * **Example:** Create a 1 MiB page blob
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
 *     const createPageBlob = yield* Azure.Storage.CreatePageBlob(files);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the container's URL and name are injected
 *         yield* createPageBlob({ blob: "disk.vhd", xMsBlobContentLength: 1024 * 1024 });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.CreatePageBlobHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface CreatePageBlob extends Binding.Service<
  CreatePageBlob,
  "Azure.Storage.CreatePageBlob",
  (
    container: BlobContainer,
  ) => Effect.Effect<
    (
      request: CreatePageBlobRequest,
    ) => Effect.Effect<blob.CreatePageBlobResponse, blob.CreatePageBlobError, RuntimeContext>
  >
> {}

export const CreatePageBlob = Binding.Service<CreatePageBlob>("Azure.Storage.CreatePageBlob");
