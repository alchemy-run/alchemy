import * as Layer from "effect/Layer";
import {
  makeSearchIndexLevelBinding,
  makeWriteSearchIndexClient,
  SearchRole,
} from "./BindingHttp.ts";
import { SearchIndexWrite } from "./SearchIndexWrite.ts";

/**
 * Implementation of {@link SearchIndexWrite} over the distilled
 * `search-data` data plane. Assigns the custom
 * `AzureSearchIndexDocumentsRole` on the index.
 *
 * @layer
 * @provides Azure.Search.SearchIndexWrite
 */
export const SearchIndexWriteHttp = Layer.effect(
  SearchIndexWrite,
  makeSearchIndexLevelBinding({
    tag: "Azure.Search.SearchIndexWrite",
    grants: [SearchRole.WriteDocuments],
    makeClient: makeWriteSearchIndexClient,
  }),
);
