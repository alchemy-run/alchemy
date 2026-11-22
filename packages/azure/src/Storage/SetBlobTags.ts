import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** `SetBlobTags` request without the `url` and `containerName` the bound container supplies. */
export interface SetBlobTagsRequest extends Omit<
  blob.SetBlobTagsRequest,
  "url" | "containerName"
> {}

/**
 * Replace a blob's index tags (`Set Blob Tags`).
 *
 * Binding grants a custom role with only `blobs/tags/write`, assigned on the
 * bound container only. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity; any other host gets
 * an Entra service principal with the role and its client secret in the
 * host's env (see `AzureBindings`). The custom role is an
 * `Azure.Authorization.RoleDefinition` created once per stack and shared by
 * every host. Provide {@link SetBlobTagsHttp}.
 *
 * ### Writing Blob Tags
 * **Example:** Tag a blob
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
 *     const setBlobTags = yield* Azure.Storage.SetBlobTags(files);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the container's URL and name are injected
 *         yield* setBlobTags({ blob: "hello.txt", BlobTagSet: [{ Key: "status", Value: "done" }] });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.SetBlobTagsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface SetBlobTags extends Binding.Service<
  SetBlobTags,
  "Azure.Storage.SetBlobTags",
  (
    container: BlobContainer,
  ) => Effect.Effect<
    (
      request: SetBlobTagsRequest,
    ) => Effect.Effect<blob.SetBlobTagsResponse, blob.SetBlobTagsError, RuntimeContext>
  >
> {}

export const SetBlobTags = Binding.Service<SetBlobTags>("Azure.Storage.SetBlobTags");
