import * as Layer from "effect/Layer";
import {
  makeReadSearchIndexClient,
  makeSearchIndexLevelBinding,
  SearchRole,
} from "./BindingHttp.ts";
import { SearchIndexRead } from "./SearchIndexRead.ts";

/**
 * Implementation of {@link SearchIndexRead} over the distilled
 * `search-data` data plane. Assigns **Search Index Data Reader** on the
 * index.
 *
 * @layer
 * @provides Azure.Search.SearchIndexRead
 */
export const SearchIndexReadHttp = Layer.effect(
  SearchIndexRead,
  makeSearchIndexLevelBinding({
    tag: "Azure.Search.SearchIndexRead",
    grants: [SearchRole.ReadDocuments],
    makeClient: makeReadSearchIndexClient,
  }),
);
