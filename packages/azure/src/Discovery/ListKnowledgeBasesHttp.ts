import * as discovery from "@distilled.cloud/azure/discovery-bookshelf";
import * as Layer from "effect/Layer";
import { DiscoveryRole, makeBookshelfHttpBinding } from "./BindingHttp.ts";
import { ListKnowledgeBases } from "./ListKnowledgeBases.ts";

/**
 * Implementation of {@link ListKnowledgeBases} over the distilled
 * `discovery-bookshelf` data plane. Assigns **Microsoft Discovery Bookshelf
 * Index Data Reader** on the bookshelf.
 *
 * @layer
 * @provides Azure.Discovery.ListKnowledgeBases
 */
export const ListKnowledgeBasesHttp = Layer.effect(
  ListKnowledgeBases,
  makeBookshelfHttpBinding({
    tag: "Azure.Discovery.ListKnowledgeBases",
    operation: discovery.ListKnowledgeBases,
    grant: DiscoveryRole.KnowledgeBaseReader,
  }),
);
