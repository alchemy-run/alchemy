import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** `GetPageBlobPageRanges` request without the `url` and `containerName` the bound container supplies. */
export interface GetPageRangesRequest extends Omit<
  blob.GetPageBlobPageRangesRequest,
  "url" | "containerName"
> {}

/**
 * List the valid page ranges of a page blob (`Get Page Ranges`).
 *
 * Binding grants **Storage Blob Data Reader** (`blobs/read`), assigned on
 * the bound container only. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity; any other host gets
 * an Entra service principal with the role and its client secret in the
 * host's env (see `AzureBindings`). Provide {@link GetPageRangesHttp}.
 *
 * ### Reading Page Ranges
 * **Example:** List a page blob's ranges
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
 *     const getPageRanges = yield* Azure.Storage.GetPageRanges(files);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the container's URL and name are injected
 *         const ranges = yield* getPageRanges({ blob: "disk.vhd" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.GetPageRangesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface GetPageRanges extends Binding.Service<
  GetPageRanges,
  "Azure.Storage.GetPageRanges",
  (
    container: BlobContainer,
  ) => Effect.Effect<
    (
      request: GetPageRangesRequest,
    ) => Effect.Effect<
      blob.GetPageBlobPageRangesResponse,
      blob.GetPageBlobPageRangesError,
      RuntimeContext
    >
  >
> {}

export const GetPageRanges = Binding.Service<GetPageRanges>("Azure.Storage.GetPageRanges");
