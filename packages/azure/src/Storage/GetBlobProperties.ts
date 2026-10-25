import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** `GetBlobProperties` request without the `url` and `containerName` the bound container supplies. */
export interface GetBlobPropertiesRequest extends Omit<
  blob.GetBlobPropertiesRequest,
  "url" | "containerName"
> {}

/**
 * Read a blob's metadata and system properties without its content (`Get
 * Blob Properties`).
 *
 * Binding grants **Storage Blob Data Reader** (`blobs/read`), assigned on
 * the bound container only. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity; any other host gets
 * an Entra service principal with the role and its client secret in the
 * host's env (see `AzureBindings`). Provide {@link GetBlobPropertiesHttp}.
 *
 * ### Reading Blob Properties
 * **Example:** Read a blob's size and type
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
 *     const getBlobProperties = yield* Azure.Storage.GetBlobProperties(files);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the container's URL and name are injected
 *         const props = yield* getBlobProperties({ blob: "hello.txt" });
 *         const size = props.contentLength;
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.GetBlobPropertiesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface GetBlobProperties extends Binding.Service<
  GetBlobProperties,
  "Azure.Storage.GetBlobProperties",
  (
    container: BlobContainer,
  ) => Effect.Effect<
    (
      request: GetBlobPropertiesRequest,
    ) => Effect.Effect<blob.GetBlobPropertiesResponse, blob.GetBlobPropertiesError, RuntimeContext>
  >
> {}

export const GetBlobProperties = Binding.Service<GetBlobProperties>(
  "Azure.Storage.GetBlobProperties",
);
