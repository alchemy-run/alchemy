import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** `GetContainerProperties` request without the `url` and `containerName` the bound container supplies. */
export interface GetContainerPropertiesRequest extends Omit<
  blob.GetContainerPropertiesRequest,
  "url" | "containerName"
> {}

/**
 * Read the container's metadata and system properties (`Get Container
 * Properties`).
 *
 * Binding grants a custom role with only `containers/read`, assigned on the
 * bound container only. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity; any other host gets
 * an Entra service principal with the role and its client secret in the
 * host's env (see `AzureBindings`). The custom role is an
 * `Azure.Authorization.RoleDefinition` created once per stack and shared by
 * every host. Provide {@link GetContainerPropertiesHttp}.
 *
 * ### Reading Container Properties
 * **Example:** Read container metadata
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
 *     const getContainerProperties = yield* Azure.Storage.GetContainerProperties(files);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the container's URL and name are injected
 *         const props = yield* getContainerProperties();
 *         const metadata = props.metadata;
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.GetContainerPropertiesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface GetContainerProperties extends Binding.Service<
  GetContainerProperties,
  "Azure.Storage.GetContainerProperties",
  (
    container: BlobContainer,
  ) => Effect.Effect<
    (
      request?: GetContainerPropertiesRequest,
    ) => Effect.Effect<
      blob.GetContainerPropertiesResponse,
      blob.GetContainerPropertiesError,
      RuntimeContext
    >
  >
> {}

export const GetContainerProperties = Binding.Service<GetContainerProperties>(
  "Azure.Storage.GetContainerProperties",
);
