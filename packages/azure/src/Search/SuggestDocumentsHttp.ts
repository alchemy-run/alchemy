import * as searchData from "@distilled.cloud/azure/search-data";
import * as Layer from "effect/Layer";
import { makeSearchIndexHttpBinding, SearchRole } from "./BindingHttp.ts";
import { SuggestDocuments } from "./SuggestDocuments.ts";

/**
 * Implementation of {@link SuggestDocuments} over the distilled `search-data`
 * data plane. Assigns **Search Index Data Reader** on the index.
 *
 * @layer
 * @provides Azure.Search.SuggestDocuments
 */
export const SuggestDocumentsHttp = Layer.effect(
  SuggestDocuments,
  makeSearchIndexHttpBinding({
    tag: "Azure.Search.SuggestDocuments",
    operation: searchData.PostDocumentsSuggest,
    grants: [SearchRole.ReadDocuments],
  }),
);
