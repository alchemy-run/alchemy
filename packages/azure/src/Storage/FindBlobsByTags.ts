import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** `ContainerFilterBlobs` request without the `url` and `containerName` the bound container supplies. */
export interface FindBlobsByTagsRequest extends Omit<
  blob.ContainerFilterBlobsRequest,
  "url" | "containerName"
> {}

/**
 * Find the container's blobs whose index tags match an expression (`Find
 * Blobs by Tags in Container`).
 *
 * Binding grants a custom role with only `blobs/filter/action`, assigned on
 * the bound container only. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity; any other host gets
 * an Entra service principal with the role and its client secret in the
 * host's env (see `AzureBindings`). The custom role is an
 * `Azure.Authorization.RoleDefinition` created once per stack and shared by
 * every host. Provide {@link FindBlobsByTagsHttp}.
 *
 * ### Finding Blobs by Tags
 * **Example:** Find finished blobs
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
 *     const findBlobsByTags = yield* Azure.Storage.FindBlobsByTags(files);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the container's URL and name are injected
 *         const res = yield* findBlobsByTags({ where: "\"status\"='done'" });
 *         const names = (res.Blobs ?? []).map((b) => b.Name);
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.FindBlobsByTagsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface FindBlobsByTags extends Binding.Service<
  FindBlobsByTags,
  "Azure.Storage.FindBlobsByTags",
  (
    container: BlobContainer,
  ) => Effect.Effect<
    (
      request?: FindBlobsByTagsRequest,
    ) => Effect.Effect<
      blob.ContainerFilterBlobsResponse,
      blob.ContainerFilterBlobsError,
      RuntimeContext
    >
  >
> {}

export const FindBlobsByTags = Binding.Service<FindBlobsByTags>("Azure.Storage.FindBlobsByTags");
