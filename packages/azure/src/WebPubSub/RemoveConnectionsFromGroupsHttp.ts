import * as webpubsub from "@distilled.cloud/azure/webpubsub-data";
import * as Layer from "effect/Layer";
import { makeHubOperationBinding, WebPubSubRole } from "./BindingHttp.ts";
import { RemoveConnectionsFromGroups } from "./RemoveConnectionsFromGroups.ts";

/**
 * Implementation of {@link RemoveConnectionsFromGroups} over the distilled `webpubsub-data`
 * data plane. Assigns the custom `AzureWebPubSubGroupWriteRole` on the hub's
 * service.
 *
 * @layer
 * @provides Azure.WebPubSub.RemoveConnectionsFromGroups
 */
export const RemoveConnectionsFromGroupsHttp = Layer.effect(
  RemoveConnectionsFromGroups,
  makeHubOperationBinding({
    tag: "Azure.WebPubSub.RemoveConnectionsFromGroups",
    operation: webpubsub.RemoveConnectionsFromGroups,
    grant: WebPubSubRole.GroupWrite,
  }),
);
