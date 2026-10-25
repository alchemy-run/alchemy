import * as discovery from "@distilled.cloud/azure/discovery-bookshelf";
import * as Layer from "effect/Layer";
import { DiscoveryRole, makeBookshelfHttpBinding } from "./BindingHttp.ts";
import { CancelKnowledgeBaseIndexing } from "./CancelKnowledgeBaseIndexing.ts";

/**
 * Implementation of {@link CancelKnowledgeBaseIndexing} over the distilled
 * `discovery-bookshelf` data plane. Assigns the custom
 * `AzureDiscoveryKnowledgeBaseWriteRole` on the bookshelf.
 *
 * @layer
 * @provides Azure.Discovery.CancelKnowledgeBaseIndexing
 */
export const CancelKnowledgeBaseIndexingHttp = Layer.effect(
  CancelKnowledgeBaseIndexing,
  makeBookshelfHttpBinding({
    tag: "Azure.Discovery.CancelKnowledgeBaseIndexing",
    operation: discovery.CancelKnowledgeBaseIndexing,
    grant: DiscoveryRole.KnowledgeBaseWrite,
  }),
);
