import * as searchData from "@distilled.cloud/azure/search-data";
import * as Layer from "effect/Layer";
import { AutocompleteDocuments } from "./AutocompleteDocuments.ts";
import { makeSearchIndexHttpBinding, SearchRole } from "./BindingHttp.ts";

/**
 * Implementation of {@link AutocompleteDocuments} over the distilled `search-data`
 * data plane. Assigns **Search Index Data Reader** on the index.
 *
 * @layer
 * @provides Azure.Search.AutocompleteDocuments
 */
export const AutocompleteDocumentsHttp = Layer.effect(
  AutocompleteDocuments,
  makeSearchIndexHttpBinding({
    tag: "Azure.Search.AutocompleteDocuments",
    operation: searchData.PostDocumentsAutocomplete,
    grants: [SearchRole.ReadDocuments],
  }),
);
