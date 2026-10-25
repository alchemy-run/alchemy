import * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Layer from "effect/Layer";
import { DiscoveryRole, makeWorkspaceHttpBinding } from "./BindingHttp.ts";
import { ListConversations } from "./ListConversations.ts";

/**
 * Implementation of {@link ListConversations} over the distilled
 * `discovery-workspace` data plane. Assigns the custom
 * `AzureDiscoveryConversationReadRole` on the workspace.
 *
 * @layer
 * @provides Azure.Discovery.ListConversations
 */
export const ListConversationsHttp = Layer.effect(
  ListConversations,
  makeWorkspaceHttpBinding({
    tag: "Azure.Discovery.ListConversations",
    operation: discovery.ListConversations,
    grant: DiscoveryRole.ConversationRead,
  }),
);
