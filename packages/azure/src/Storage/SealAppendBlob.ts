import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** `SealAppendBlob` request without the `url` and `containerName` the bound container supplies. */
export interface SealAppendBlobRequest extends Omit<
  blob.SealAppendBlobRequest,
  "url" | "containerName"
> {}

/**
 * Seal an append blob so it accepts no more blocks (`Seal Blob`).
 *
 * Binding grants a custom role with only `blobs/write`, assigned on the
 * bound container only. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity; any other host gets
 * an Entra service principal with the role and its client secret in the
 * host's env (see `AzureBindings`). The custom role is an
 * `Azure.Authorization.RoleDefinition` created once per stack and shared by
 * every host. Provide {@link SealAppendBlobHttp}.
 *
 * ### Sealing Append Blobs
 * **Example:** Seal a finished log
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
 *     const sealAppendBlob = yield* Azure.Storage.SealAppendBlob(files);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the container's URL and name are injected
 *         yield* sealAppendBlob({ blob: "logs/yesterday.log" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.SealAppendBlobHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface SealAppendBlob extends Binding.Service<
  SealAppendBlob,
  "Azure.Storage.SealAppendBlob",
  (
    container: BlobContainer,
  ) => Effect.Effect<
    (
      request: SealAppendBlobRequest,
    ) => Effect.Effect<blob.SealAppendBlobResponse, blob.SealAppendBlobError, RuntimeContext>
  >
> {}

export const SealAppendBlob = Binding.Service<SealAppendBlob>("Azure.Storage.SealAppendBlob");
