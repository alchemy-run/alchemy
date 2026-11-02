import * as data from "@distilled.cloud/stackit/opensearch_data";
import * as Layer from "effect/Layer";
import { makeIndexBinding } from "./BindingHttp.ts";
import { Search, type SearchRequest } from "./Search.ts";

/**
 * HTTP implementation of {@link Search}, on OpenSearch's REST API.
 *
 * @layer
 * @provides Stackit.OpenSearch.Search
 */
export const SearchHttp = Layer.succeed(
  Search,
  makeIndexBinding((call) => (request: SearchRequest) => call(data.search, request)),
);
