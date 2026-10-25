import * as searchData from "@distilled.cloud/azure/search-data";
import * as Layer from "effect/Layer";
import { makeSearchIndexHttpBinding, SearchRole } from "./BindingHttp.ts";
import { CountDocuments } from "./CountDocuments.ts";

/**
 * Implementation of {@link CountDocuments} over the distilled `search-data`
 * data plane. Assigns **Search Index Data Reader** on the index.
 *
 * @layer
 * @provides Azure.Search.CountDocuments
 */
export const CountDocumentsHttp = Layer.effect(
  CountDocuments,
  makeSearchIndexHttpBinding({
    tag: "Azure.Search.CountDocuments",
    operation: searchData.DocumentsCount,
    grants: [SearchRole.ReadDocuments],
  }),
);
