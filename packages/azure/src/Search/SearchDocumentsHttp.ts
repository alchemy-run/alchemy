import * as searchData from "@distilled.cloud/azure/search-data";
import * as Layer from "effect/Layer";
import { makeSearchIndexHttpBinding, SearchRole } from "./BindingHttp.ts";
import { SearchDocuments } from "./SearchDocuments.ts";

/**
 * Implementation of {@link SearchDocuments} over the distilled `search-data`
 * data plane. Assigns **Search Index Data Reader** on the index.
 *
 * @layer
 * @provides Azure.Search.SearchDocuments
 */
export const SearchDocumentsHttp = Layer.effect(
  SearchDocuments,
  makeSearchIndexHttpBinding({
    tag: "Azure.Search.SearchDocuments",
    operation: searchData.DocumentsSearchPost,
    grants: [SearchRole.ReadDocuments],
  }),
);
