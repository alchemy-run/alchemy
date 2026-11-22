import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** `GetBlobTags` request without the `url` and `containerName` the bound container supplies. */
export interface GetBlobTagsRequest extends Omit<
  blob.GetBlobTagsRequest,
  "url" | "containerName"
> {}

/**
 * Read a blob's index tags (`Get Blob Tags`).
 *
 * Binding grants a custom role with only `blobs/tags/read`, assigned on the
 * bound container only. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity; any other host gets
 * an Entra service principal with the role and its client secret in the
 * host's env (see `AzureBindings`). The custom role is an
 * `Azure.Authorization.RoleDefinition` created once per stack and shared by
 * every host. Provide {@link GetBlobTagsHttp}.
 *
 * ### Reading Blob Tags
 * **Example:** Read a blob's tags
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
 *     const getBlobTags = yield* Azure.Storage.GetBlobTags(files);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the container's URL and name are injected
 *         const res = yield* getBlobTags({ blob: "hello.txt" });
 *         const tags = res.BlobTagSet;
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.GetBlobTagsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface GetBlobTags extends Binding.Service<
  GetBlobTags,
  "Azure.Storage.GetBlobTags",
  (
    container: BlobContainer,
  ) => Effect.Effect<
    (
      request: GetBlobTagsRequest,
    ) => Effect.Effect<blob.GetBlobTagsResponse, blob.GetBlobTagsError, RuntimeContext>
  >
> {}

export const GetBlobTags = Binding.Service<GetBlobTags>("Azure.Storage.GetBlobTags");
