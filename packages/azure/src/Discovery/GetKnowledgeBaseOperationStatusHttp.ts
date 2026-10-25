import * as discovery from "@distilled.cloud/azure/discovery-bookshelf";
import * as Layer from "effect/Layer";
import { DiscoveryRole, makeBookshelfHttpBinding } from "./BindingHttp.ts";
import { GetKnowledgeBaseOperationStatus } from "./GetKnowledgeBaseOperationStatus.ts";

/**
 * Implementation of {@link GetKnowledgeBaseOperationStatus} over the distilled
 * `discovery-bookshelf` data plane. Assigns **Microsoft Discovery Bookshelf
 * Index Data Reader** on the bookshelf.
 *
 * @layer
 * @provides Azure.Discovery.GetKnowledgeBaseOperationStatus
 */
export const GetKnowledgeBaseOperationStatusHttp = Layer.effect(
  GetKnowledgeBaseOperationStatus,
  makeBookshelfHttpBinding({
    tag: "Azure.Discovery.GetKnowledgeBaseOperationStatus",
    operation: discovery.GetKnowledgeBaseOperationStatus,
    grant: DiscoveryRole.KnowledgeBaseReader,
  }),
);
