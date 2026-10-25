import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** `GetPageBlobPageRangesDiff` request without the `url` and `containerName` the bound container supplies. */
export interface GetPageRangesDiffRequest extends Omit<
  blob.GetPageBlobPageRangesDiffRequest,
  "url" | "containerName"
> {}

/**
 * List the page ranges of a page blob that changed since a snapshot (`Get
 * Page Ranges` with `prevsnapshot`).
 *
 * Binding grants **Storage Blob Data Reader** (`blobs/read`), assigned on
 * the bound container only. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity; any other host gets
 * an Entra service principal with the role and its client secret in the
 * host's env (see `AzureBindings`). Provide {@link GetPageRangesDiffHttp}.
 *
 * ### Diffing Page Ranges
 * **Example:** Pages changed since a snapshot
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
 *     const getPageRangesDiff = yield* Azure.Storage.GetPageRangesDiff(files);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the container's URL and name are injected
 *         const diff = yield* getPageRangesDiff({ blob: "disk.vhd", prevsnapshot: snapshot });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.GetPageRangesDiffHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface GetPageRangesDiff extends Binding.Service<
  GetPageRangesDiff,
  "Azure.Storage.GetPageRangesDiff",
  (
    container: BlobContainer,
  ) => Effect.Effect<
    (
      request: GetPageRangesDiffRequest,
    ) => Effect.Effect<
      blob.GetPageBlobPageRangesDiffResponse,
      blob.GetPageBlobPageRangesDiffError,
      RuntimeContext
    >
  >
> {}

export const GetPageRangesDiff = Binding.Service<GetPageRangesDiff>(
  "Azure.Storage.GetPageRangesDiff",
);
