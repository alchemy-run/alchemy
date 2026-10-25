import * as discovery from "@distilled.cloud/azure/discovery-bookshelf";
import * as Layer from "effect/Layer";
import { DiscoveryRole, makeBookshelfHttpBinding } from "./BindingHttp.ts";
import { CreateOrUpdateKnowledgeBase } from "./CreateOrUpdateKnowledgeBase.ts";

/**
 * Implementation of {@link CreateOrUpdateKnowledgeBase} over the distilled
 * `discovery-bookshelf` data plane. Assigns the custom
 * `AzureDiscoveryKnowledgeBaseWriteRole` on the bookshelf.
 *
 * @layer
 * @provides Azure.Discovery.CreateOrUpdateKnowledgeBase
 */
export const CreateOrUpdateKnowledgeBaseHttp = Layer.effect(
  CreateOrUpdateKnowledgeBase,
  makeBookshelfHttpBinding({
    tag: "Azure.Discovery.CreateOrUpdateKnowledgeBase",
    operation: discovery.KnowledgeBasesCreateOrUpdate,
    grant: DiscoveryRole.KnowledgeBaseWrite,
  }),
);
