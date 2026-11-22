import * as webpubsub from "@distilled.cloud/azure/webpubsub-data";
import * as Layer from "effect/Layer";
import { makeHubOperationBinding, WebPubSubRole } from "./BindingHttp.ts";
import { SendToConnection } from "./SendToConnection.ts";

/**
 * Implementation of {@link SendToConnection} over the distilled `webpubsub-data`
 * data plane. Assigns the custom `AzureWebPubSubConnectionSendRole` on the hub's
 * service.
 *
 * @layer
 * @provides Azure.WebPubSub.SendToConnection
 */
export const SendToConnectionHttp = Layer.effect(
  SendToConnection,
  makeHubOperationBinding({
    tag: "Azure.WebPubSub.SendToConnection",
    operation: webpubsub.SendToConnection,
    grant: WebPubSubRole.ConnectionSend,
  }),
);
