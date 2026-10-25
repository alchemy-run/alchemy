import * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Layer from "effect/Layer";
import { DiscoveryRole, makeWorkspaceHttpBinding } from "./BindingHttp.ts";
import { DeleteConversation } from "./DeleteConversation.ts";

/**
 * Implementation of {@link DeleteConversation} over the distilled
 * `discovery-workspace` data plane. Assigns the custom
 * `AzureDiscoveryConversationDeleteRole` on the workspace.
 *
 * @layer
 * @provides Azure.Discovery.DeleteConversation
 */
export const DeleteConversationHttp = Layer.effect(
  DeleteConversation,
  makeWorkspaceHttpBinding({
    tag: "Azure.Discovery.DeleteConversation",
    operation: discovery.DeleteConversation,
    grant: DiscoveryRole.ConversationDelete,
  }),
);
