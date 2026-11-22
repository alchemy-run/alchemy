import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** `BlockAppendBlobAppend` request without the `url` and `containerName` the bound container supplies. */
export interface AppendBlockRequest extends Omit<
  blob.BlockAppendBlobAppendRequest,
  "url" | "containerName"
> {}

/**
 * Append a block to the end of an append blob (`Append Block`).
 *
 * Binding grants a custom role with only `blobs/write`, assigned on the
 * bound container only. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity; any other host gets
 * an Entra service principal with the role and its client secret in the
 * host's env (see `AzureBindings`). The custom role is an
 * `Azure.Authorization.RoleDefinition` created once per stack and shared by
 * every host. Provide {@link AppendBlockHttp}.
 *
 * ### Appending to Blobs
 * **Example:** Append a log line
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
 *     const appendBlock = yield* Azure.Storage.AppendBlock(files);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the container's URL and name are injected
 *         yield* appendBlock({ blob: "logs/today.log", body: new TextEncoder().encode("started\n") });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.AppendBlockHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface AppendBlock extends Binding.Service<
  AppendBlock,
  "Azure.Storage.AppendBlock",
  (
    container: BlobContainer,
  ) => Effect.Effect<
    (
      request: AppendBlockRequest,
    ) => Effect.Effect<
      blob.BlockAppendBlobAppendResponse,
      blob.BlockAppendBlobAppendError,
      RuntimeContext
    >
  >
> {}

export const AppendBlock = Binding.Service<AppendBlock>("Azure.Storage.AppendBlock");
