import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** `BlobQuery` request without the `url` and `containerName` the bound container supplies. */
export interface QueryBlobRequest extends Omit<blob.BlobQueryRequest, "url" | "containerName"> {}

/**
 * Run a SQL query over a CSV or JSON blob and stream back the matching
 * records (`Query Blob Contents`).
 *
 * Binding grants **Storage Blob Data Reader** (`blobs/read`), assigned on
 * the bound container only. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity; any other host gets
 * an Entra service principal with the role and its client secret in the
 * host's env (see `AzureBindings`). Provide {@link QueryBlobHttp}.
 *
 * ### Querying Blobs
 * **Example:** Select rows from a CSV blob
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
 *     const queryBlob = yield* Azure.Storage.QueryBlob(files);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the container's URL and name are injected
 *         const res = yield* queryBlob({
 *           blob: "data.csv",
 *           QueryType: "SQL",
 *           Expression: "SELECT * FROM BlobStorage",
 *         });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.QueryBlobHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface QueryBlob extends Binding.Service<
  QueryBlob,
  "Azure.Storage.QueryBlob",
  (
    container: BlobContainer,
  ) => Effect.Effect<
    (
      request: QueryBlobRequest,
    ) => Effect.Effect<blob.BlobQueryResponse, blob.BlobQueryError, RuntimeContext>
  >
> {}

export const QueryBlob = Binding.Service<QueryBlob>("Azure.Storage.QueryBlob");
