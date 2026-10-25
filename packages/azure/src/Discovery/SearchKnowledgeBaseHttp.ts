import * as discovery from "@distilled.cloud/azure/discovery-bookshelf";
import * as Layer from "effect/Layer";
import { DiscoveryRole, makeBookshelfHttpBinding } from "./BindingHttp.ts";
import { SearchKnowledgeBase } from "./SearchKnowledgeBase.ts";

/**
 * Implementation of {@link SearchKnowledgeBase} over the distilled
 * `discovery-bookshelf` data plane. Assigns **Microsoft Discovery Bookshelf
 * Index Data Reader** on the bookshelf.
 *
 * @layer
 * @provides Azure.Discovery.SearchKnowledgeBase
 */
export const SearchKnowledgeBaseHttp = Layer.effect(
  SearchKnowledgeBase,
  makeBookshelfHttpBinding({
    tag: "Azure.Discovery.SearchKnowledgeBase",
    operation: discovery.SearchKnowledgeBase,
    grant: DiscoveryRole.KnowledgeBaseReader,
  }),
);
