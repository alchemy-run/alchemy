import * as webpubsub from "@distilled.cloud/azure/webpubsub-data";
import * as Layer from "effect/Layer";
import { makeHubOperationBinding, WebPubSubRole } from "./BindingHttp.ts";
import { SendToGroup } from "./SendToGroup.ts";

/**
 * Implementation of {@link SendToGroup} over the distilled `webpubsub-data`
 * data plane. Assigns the custom `AzureWebPubSubGroupSendRole` on the hub's
 * service.
 *
 * @layer
 * @provides Azure.WebPubSub.SendToGroup
 */
export const SendToGroupHttp = Layer.effect(
  SendToGroup,
  makeHubOperationBinding({
    tag: "Azure.WebPubSub.SendToGroup",
    operation: webpubsub.SendToGroup,
    grant: WebPubSubRole.GroupSend,
  }),
);
