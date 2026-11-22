import * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Layer from "effect/Layer";
import { DiscoveryRole, makeWorkspaceHttpBinding } from "./BindingHttp.ts";
import { GetConversation } from "./GetConversation.ts";

/**
 * Implementation of {@link GetConversation} over the distilled
 * `discovery-workspace` data plane. Assigns the custom
 * `AzureDiscoveryConversationReadRole` on the workspace.
 *
 * @layer
 * @provides Azure.Discovery.GetConversation
 */
export const GetConversationHttp = Layer.effect(
  GetConversation,
  makeWorkspaceHttpBinding({
    tag: "Azure.Discovery.GetConversation",
    operation: discovery.GetConversation,
    grant: DiscoveryRole.ConversationRead,
  }),
);
