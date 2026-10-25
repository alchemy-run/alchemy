import * as webpubsub from "@distilled.cloud/azure/webpubsub-data";
import * as Layer from "effect/Layer";
import { AddConnectionsToGroups } from "./AddConnectionsToGroups.ts";
import { makeHubOperationBinding, WebPubSubRole } from "./BindingHttp.ts";

/**
 * Implementation of {@link AddConnectionsToGroups} over the distilled `webpubsub-data`
 * data plane. Assigns the custom `AzureWebPubSubGroupWriteRole` on the hub's
 * service.
 *
 * @layer
 * @provides Azure.WebPubSub.AddConnectionsToGroups
 */
export const AddConnectionsToGroupsHttp = Layer.effect(
  AddConnectionsToGroups,
  makeHubOperationBinding({
    tag: "Azure.WebPubSub.AddConnectionsToGroups",
    operation: webpubsub.AddConnectionsToGroups,
    grant: WebPubSubRole.GroupWrite,
  }),
);
