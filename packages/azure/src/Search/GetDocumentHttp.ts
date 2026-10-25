import * as searchData from "@distilled.cloud/azure/search-data";
import * as Layer from "effect/Layer";
import { makeSearchIndexHttpBinding, SearchRole } from "./BindingHttp.ts";
import { GetDocument } from "./GetDocument.ts";

/**
 * Implementation of {@link GetDocument} over the distilled `search-data`
 * data plane. Assigns **Search Index Data Reader** on the index.
 *
 * @layer
 * @provides Azure.Search.GetDocument
 */
export const GetDocumentHttp = Layer.effect(
  GetDocument,
  makeSearchIndexHttpBinding({
    tag: "Azure.Search.GetDocument",
    operation: searchData.GetDocument,
    grants: [SearchRole.ReadDocuments],
  }),
);
