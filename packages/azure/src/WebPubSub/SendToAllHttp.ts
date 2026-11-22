import * as webpubsub from "@distilled.cloud/azure/webpubsub-data";
import * as Layer from "effect/Layer";
import { makeHubOperationBinding, WebPubSubRole } from "./BindingHttp.ts";
import { SendToAll } from "./SendToAll.ts";

/**
 * Implementation of {@link SendToAll} over the distilled `webpubsub-data`
 * data plane. Assigns the custom `AzureWebPubSubHubSendRole` on the hub's
 * service.
 *
 * @layer
 * @provides Azure.WebPubSub.SendToAll
 */
export const SendToAllHttp = Layer.effect(
  SendToAll,
  makeHubOperationBinding({
    tag: "Azure.WebPubSub.SendToAll",
    operation: webpubsub.SendToAll,
    grant: WebPubSubRole.HubSend,
  }),
);
