import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** `BlockBlobStageBlock` request without the `url` and `containerName` the bound container supplies. */
export interface StageBlockRequest extends Omit<
  blob.BlockBlobStageBlockRequest,
  "url" | "containerName"
> {}

/**
 * Upload one uncommitted block of a block blob (`Put Block`); commit it with
 * `CommitBlockList`.
 *
 * Binding grants a custom role with only `blobs/write`, assigned on the
 * bound container only. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity; any other host gets
 * an Entra service principal with the role and its client secret in the
 * host's env (see `AzureBindings`). The custom role is an
 * `Azure.Authorization.RoleDefinition` created once per stack and shared by
 * every host. Provide {@link StageBlockHttp}.
 *
 * ### Staging Blocks
 * **Example:** Stage a block
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
 *     const stageBlock = yield* Azure.Storage.StageBlock(files);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the container's URL and name are injected
 *         yield* stageBlock({ blob: "big.bin", blockid: btoa("block-0"), body: chunk });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.StageBlockHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface StageBlock extends Binding.Service<
  StageBlock,
  "Azure.Storage.StageBlock",
  (
    container: BlobContainer,
  ) => Effect.Effect<
    (
      request: StageBlockRequest,
    ) => Effect.Effect<
      blob.BlockBlobStageBlockResponse,
      blob.BlockBlobStageBlockError,
      RuntimeContext
    >
  >
> {}

export const StageBlock = Binding.Service<StageBlock>("Azure.Storage.StageBlock");
