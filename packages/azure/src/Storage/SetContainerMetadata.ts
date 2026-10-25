import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** `SetContainerMetadata` request without the `url` and `containerName` the bound container supplies. */
export interface SetContainerMetadataRequest extends Omit<
  blob.SetContainerMetadataRequest,
  "url" | "containerName"
> {}

/**
 * Replace the container's user metadata (`Set Container Metadata`).
 *
 * Binding grants a custom role with only `containers/write`, assigned on the
 * bound container only. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity; any other host gets
 * an Entra service principal with the role and its client secret in the
 * host's env (see `AzureBindings`). The custom role is an
 * `Azure.Authorization.RoleDefinition` created once per stack and shared by
 * every host. Provide {@link SetContainerMetadataHttp}.
 *
 * ### Setting Container Metadata
 * **Example:** Record a sync time
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
 *     const setContainerMetadata = yield* Azure.Storage.SetContainerMetadata(files);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the container's URL and name are injected
 *         yield* setContainerMetadata({ metadata: { lastsync: new Date().toISOString() } });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.SetContainerMetadataHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface SetContainerMetadata extends Binding.Service<
  SetContainerMetadata,
  "Azure.Storage.SetContainerMetadata",
  (
    container: BlobContainer,
  ) => Effect.Effect<
    (
      request?: SetContainerMetadataRequest,
    ) => Effect.Effect<
      blob.SetContainerMetadataResponse,
      blob.SetContainerMetadataError,
      RuntimeContext
    >
  >
> {}

export const SetContainerMetadata = Binding.Service<SetContainerMetadata>(
  "Azure.Storage.SetContainerMetadata",
);
