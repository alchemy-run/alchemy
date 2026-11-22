import type * as searchData from "@distilled.cloud/azure/search-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { SearchIndex } from "./SearchIndex.ts";

export interface GetDocumentRequest extends Omit<
  searchData.GetDocumentRequest,
  "endpoint" | "indexName"
> {}

/**
 * Look up one document by key in an Azure AI Search index from any host.
 * A missing key fails with `NotFound`.
 *
 * Binding assigns **Search Index Data Reader** (exactly the data action
 * `indexes/documents/read`) on the index only. The search service must accept Microsoft Entra ID
 * tokens (`authMode: "aadOrApiKey"`). On a host with a managed identity
 * (an Azure Function, Function App, Web App, Container App, container
 * group, VM, or AKS workload identity) the role goes to that identity; any
 * other host (a Cloudflare Worker, an AWS Lambda) gets an Entra service
 * principal (see `AzureBindings`). Provide {@link GetDocumentHttp}.
 *
 * ### Calling GetDocument
 * **Example:** Look up a document by key
 * ```typescript
 * // init
 * const getHotel = yield* Azure.Search.GetDocument(index);
 *
 * // runtime
 * const hotel = yield* getHotel({ key: "1", _select: "id,name" });
 * ```
 *
 * @binding
 * @category Search
 */
export interface GetDocument extends Binding.Service<
  GetDocument,
  "Azure.Search.GetDocument",
  (
    index: SearchIndex,
  ) => Effect.Effect<
    (
      request: GetDocumentRequest,
    ) => Effect.Effect<searchData.GetDocumentResponse, searchData.GetDocumentError, RuntimeContext>
  >
> {}

export const GetDocument = Binding.Service<GetDocument>("Azure.Search.GetDocument");
