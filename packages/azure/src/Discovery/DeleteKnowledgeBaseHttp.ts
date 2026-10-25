import * as discovery from "@distilled.cloud/azure/discovery-bookshelf";
import * as Layer from "effect/Layer";
import { DiscoveryRole, makeBookshelfHttpBinding } from "./BindingHttp.ts";
import { DeleteKnowledgeBase } from "./DeleteKnowledgeBase.ts";

/**
 * Implementation of {@link DeleteKnowledgeBase} over the distilled
 * `discovery-bookshelf` data plane. Assigns the custom
 * `AzureDiscoveryKnowledgeBaseDeleteRole` on the bookshelf.
 *
 * @layer
 * @provides Azure.Discovery.DeleteKnowledgeBase
 */
export const DeleteKnowledgeBaseHttp = Layer.effect(
  DeleteKnowledgeBase,
  makeBookshelfHttpBinding({
    tag: "Azure.Discovery.DeleteKnowledgeBase",
    operation: discovery.DeleteKnowledgeBase,
    grant: DiscoveryRole.KnowledgeBaseDelete,
  }),
);
