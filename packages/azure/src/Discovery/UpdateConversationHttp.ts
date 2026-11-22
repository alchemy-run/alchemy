import * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Layer from "effect/Layer";
import { DiscoveryRole, makeWorkspaceHttpBinding } from "./BindingHttp.ts";
import { UpdateConversation } from "./UpdateConversation.ts";

/**
 * Implementation of {@link UpdateConversation} over the distilled
 * `discovery-workspace` data plane. Assigns the custom
 * `AzureDiscoveryConversationWriteRole` on the workspace.
 *
 * @layer
 * @provides Azure.Discovery.UpdateConversation
 */
export const UpdateConversationHttp = Layer.effect(
  UpdateConversation,
  makeWorkspaceHttpBinding({
    tag: "Azure.Discovery.UpdateConversation",
    operation: discovery.UpdateConversation,
    grant: DiscoveryRole.ConversationWrite,
  }),
);
