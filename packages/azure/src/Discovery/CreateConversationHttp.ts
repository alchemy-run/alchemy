import * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Layer from "effect/Layer";
import { DiscoveryRole, makeWorkspaceHttpBinding } from "./BindingHttp.ts";
import { CreateConversation } from "./CreateConversation.ts";

/**
 * Implementation of {@link CreateConversation} over the distilled
 * `discovery-workspace` data plane. Assigns the custom
 * `AzureDiscoveryConversationWriteRole` on the workspace.
 *
 * @layer
 * @provides Azure.Discovery.CreateConversation
 */
export const CreateConversationHttp = Layer.effect(
  CreateConversation,
  makeWorkspaceHttpBinding({
    tag: "Azure.Discovery.CreateConversation",
    operation: discovery.CreateConversation,
    grant: DiscoveryRole.ConversationWrite,
  }),
);
