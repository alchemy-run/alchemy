import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** `ListBlockBlobCommitBlock` request without the `url` and `containerName` the bound container supplies. */
export interface CommitBlockListRequest extends Omit<
  blob.ListBlockBlobCommitBlockRequest,
  "url" | "containerName"
> {}

/**
 * Write a block blob from a list of staged or committed block IDs (`Put
 * Block List`).
 *
 * Binding grants a custom role with only `blobs/write`, assigned on the
 * bound container only. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity; any other host gets
 * an Entra service principal with the role and its client secret in the
 * host's env (see `AzureBindings`). The custom role is an
 * `Azure.Authorization.RoleDefinition` created once per stack and shared by
 * every host. Provide {@link CommitBlockListHttp}.
 *
 * ### Committing Blocks
 * **Example:** Commit staged blocks
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
 *     const commitBlockList = yield* Azure.Storage.CommitBlockList(files);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the container's URL and name are injected
 *         yield* commitBlockList({ blob: "big.bin", Latest: [btoa("block-0"), btoa("block-1")] });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.CommitBlockListHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface CommitBlockList extends Binding.Service<
  CommitBlockList,
  "Azure.Storage.CommitBlockList",
  (
    container: BlobContainer,
  ) => Effect.Effect<
    (
      request: CommitBlockListRequest,
    ) => Effect.Effect<
      blob.ListBlockBlobCommitBlockResponse,
      blob.ListBlockBlobCommitBlockError,
      RuntimeContext
    >
  >
> {}

export const CommitBlockList = Binding.Service<CommitBlockList>("Azure.Storage.CommitBlockList");
