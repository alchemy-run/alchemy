import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** `CreateAppendBlob` request without the `url` and `containerName` the bound container supplies. */
export interface CreateAppendBlobRequest extends Omit<
  blob.CreateAppendBlobRequest,
  "url" | "containerName"
> {}

/**
 * Create an empty append blob (`Put Blob` with `x-ms-blob-type:
 * AppendBlob`).
 *
 * Binding grants a custom role with only `blobs/write`, assigned on the
 * bound container only. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity; any other host gets
 * an Entra service principal with the role and its client secret in the
 * host's env (see `AzureBindings`). The custom role is an
 * `Azure.Authorization.RoleDefinition` created once per stack and shared by
 * every host. Provide {@link CreateAppendBlobHttp}.
 *
 * ### Creating Append Blobs
 * **Example:** Create a log blob
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
 *     const createAppendBlob = yield* Azure.Storage.CreateAppendBlob(files);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the container's URL and name are injected
 *         yield* createAppendBlob({ blob: "logs/today.log", xMsBlobContentType: "text/plain" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.CreateAppendBlobHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface CreateAppendBlob extends Binding.Service<
  CreateAppendBlob,
  "Azure.Storage.CreateAppendBlob",
  (
    container: BlobContainer,
  ) => Effect.Effect<
    (
      request: CreateAppendBlobRequest,
    ) => Effect.Effect<blob.CreateAppendBlobResponse, blob.CreateAppendBlobError, RuntimeContext>
  >
> {}

export const CreateAppendBlob = Binding.Service<CreateAppendBlob>("Azure.Storage.CreateAppendBlob");
