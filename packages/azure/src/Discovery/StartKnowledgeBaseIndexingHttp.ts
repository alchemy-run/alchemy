import * as discovery from "@distilled.cloud/azure/discovery-bookshelf";
import * as Layer from "effect/Layer";
import { DiscoveryRole, makeBookshelfHttpBinding } from "./BindingHttp.ts";
import { StartKnowledgeBaseIndexing } from "./StartKnowledgeBaseIndexing.ts";

/**
 * Implementation of {@link StartKnowledgeBaseIndexing} over the distilled
 * `discovery-bookshelf` data plane. Assigns the custom
 * `AzureDiscoveryKnowledgeBaseWriteRole` on the bookshelf.
 *
 * @layer
 * @provides Azure.Discovery.StartKnowledgeBaseIndexing
 */
export const StartKnowledgeBaseIndexingHttp = Layer.effect(
  StartKnowledgeBaseIndexing,
  makeBookshelfHttpBinding({
    tag: "Azure.Discovery.StartKnowledgeBaseIndexing",
    operation: discovery.StartKnowledgeBaseIndexing,
    grant: DiscoveryRole.KnowledgeBaseWrite,
  }),
);
