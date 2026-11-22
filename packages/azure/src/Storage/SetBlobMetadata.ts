import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** `SetBlobMetadata` request without the `url` and `containerName` the bound container supplies. */
export interface SetBlobMetadataRequest extends Omit<
  blob.SetBlobMetadataRequest,
  "url" | "containerName"
> {}

/**
 * Replace a blob's user metadata (`Set Blob Metadata`).
 *
 * Binding grants a custom role with only `blobs/write`, assigned on the
 * bound container only. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity; any other host gets
 * an Entra service principal with the role and its client secret in the
 * host's env (see `AzureBindings`). The custom role is an
 * `Azure.Authorization.RoleDefinition` created once per stack and shared by
 * every host. Provide {@link SetBlobMetadataHttp}.
 *
 * ### Setting Metadata
 * **Example:** Tag a blob with metadata
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
 *     const setBlobMetadata = yield* Azure.Storage.SetBlobMetadata(files);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the container's URL and name are injected
 *         yield* setBlobMetadata({ blob: "hello.txt", metadata: { owner: "api" } });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.SetBlobMetadataHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface SetBlobMetadata extends Binding.Service<
  SetBlobMetadata,
  "Azure.Storage.SetBlobMetadata",
  (
    container: BlobContainer,
  ) => Effect.Effect<
    (
      request: SetBlobMetadataRequest,
    ) => Effect.Effect<blob.SetBlobMetadataResponse, blob.SetBlobMetadataError, RuntimeContext>
  >
> {}

export const SetBlobMetadata = Binding.Service<SetBlobMetadata>("Azure.Storage.SetBlobMetadata");
