import * as searchData from "@distilled.cloud/azure/search-data";
import * as Layer from "effect/Layer";
import { makeSearchIndexHttpBinding, SearchRole } from "./BindingHttp.ts";
import { IndexDocuments } from "./IndexDocuments.ts";

/**
 * Implementation of {@link IndexDocuments} over the distilled `search-data`
 * data plane. Assigns the custom
 * `AzureSearchIndexDocumentsRole` on the index.
 *
 * @layer
 * @provides Azure.Search.IndexDocuments
 */
export const IndexDocumentsHttp = Layer.effect(
  IndexDocuments,
  makeSearchIndexHttpBinding({
    tag: "Azure.Search.IndexDocuments",
    operation: searchData.ListDocuments,
    grants: [SearchRole.WriteDocuments],
  }),
);
