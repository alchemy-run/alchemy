import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** `BlockBlobGetBlockList` request without the `url` and `containerName` the bound container supplies. */
export interface GetBlockListRequest extends Omit<
  blob.BlockBlobGetBlockListRequest,
  "url" | "containerName"
> {}

/**
 * List a block blob's committed and uncommitted blocks (`Get Block List`).
 *
 * Binding grants **Storage Blob Data Reader** (`blobs/read`), assigned on
 * the bound container only. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity; any other host gets
 * an Entra service principal with the role and its client secret in the
 * host's env (see `AzureBindings`). Provide {@link GetBlockListHttp}.
 *
 * ### Reading Block Lists
 * **Example:** List committed blocks
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
 *     const getBlockList = yield* Azure.Storage.GetBlockList(files);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the container's URL and name are injected
 *         const list = yield* getBlockList({ blob: "big.bin", blocklisttype: "committed" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.GetBlockListHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface GetBlockList extends Binding.Service<
  GetBlockList,
  "Azure.Storage.GetBlockList",
  (
    container: BlobContainer,
  ) => Effect.Effect<
    (
      request: GetBlockListRequest,
    ) => Effect.Effect<
      blob.BlockBlobGetBlockListResponse,
      blob.BlockBlobGetBlockListError,
      RuntimeContext
    >
  >
> {}

export const GetBlockList = Binding.Service<GetBlockList>("Azure.Storage.GetBlockList");
