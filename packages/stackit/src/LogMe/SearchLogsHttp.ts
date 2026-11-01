import * as data from "@distilled.cloud/stackit/opensearch_data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeOpenSearchCaller } from "../OpenSearch/BindingHttp.ts";
import type { Credential } from "./Credential.ts";
import { SearchLogs, type SearchLogsRequest } from "./SearchLogs.ts";

/**
 * HTTP implementation of {@link SearchLogs}, on the OpenSearch REST API a LogMe instance
 * serves.
 *
 * @layer
 * @provides Stackit.LogMe.SearchLogs
 */
export const SearchLogsHttp = Layer.succeed(
  SearchLogs,
  Effect.fn(function* (credential: Credential) {
    const uri = yield* credential.uri;
    const username = yield* credential.username;
    const password = yield* credential.password;
    const call = makeOpenSearchCaller({ uri, username, password });
    return (request: SearchLogsRequest) =>
      call(data.search, { ...request, index: request.index ?? "*" });
  }),
);
