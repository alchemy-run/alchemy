import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  makeReadSearchIndexClient,
  makeSearchIndexLevelBinding,
  makeWriteSearchIndexClient,
  type SearchIndexAddress,
  SearchRole,
} from "./BindingHttp.ts";
import { type ReadWriteSearchIndexClient, SearchIndexReadWrite } from "./SearchIndexReadWrite.ts";

/**
 * Implementation of {@link SearchIndexReadWrite} over the distilled
 * `search-data` data plane. Assigns **Search Index Data Reader** and the
 * custom `AzureSearchIndexDocumentsRole` on the index.
 *
 * @layer
 * @provides Azure.Search.SearchIndexReadWrite
 */
export const SearchIndexReadWriteHttp = Layer.effect(
  SearchIndexReadWrite,
  makeSearchIndexLevelBinding({
    tag: "Azure.Search.SearchIndexReadWrite",
    grants: [SearchRole.ReadDocuments, SearchRole.WriteDocuments],
    makeClient: Effect.gen(function* () {
      const makeRead = yield* makeReadSearchIndexClient;
      const makeWrite = yield* makeWriteSearchIndexClient;
      return (address: SearchIndexAddress): ReadWriteSearchIndexClient => ({
        ...makeRead(address),
        ...makeWrite(address),
      });
    }),
  }),
);
