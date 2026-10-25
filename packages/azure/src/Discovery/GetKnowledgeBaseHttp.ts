import * as discovery from "@distilled.cloud/azure/discovery-bookshelf";
import * as Layer from "effect/Layer";
import { DiscoveryRole, makeBookshelfHttpBinding } from "./BindingHttp.ts";
import { GetKnowledgeBase } from "./GetKnowledgeBase.ts";

/**
 * Implementation of {@link GetKnowledgeBase} over the distilled
 * `discovery-bookshelf` data plane. Assigns **Microsoft Discovery Bookshelf
 * Index Data Reader** on the bookshelf.
 *
 * @layer
 * @provides Azure.Discovery.GetKnowledgeBase
 */
export const GetKnowledgeBaseHttp = Layer.effect(
  GetKnowledgeBase,
  makeBookshelfHttpBinding({
    tag: "Azure.Discovery.GetKnowledgeBase",
    operation: discovery.GetKnowledgeBase,
    grant: DiscoveryRole.KnowledgeBaseReader,
  }),
);
