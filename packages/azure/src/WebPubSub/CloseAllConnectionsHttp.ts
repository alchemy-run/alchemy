import * as webpubsub from "@distilled.cloud/azure/webpubsub-data";
import * as Layer from "effect/Layer";
import { makeHubOperationBinding, WebPubSubRole } from "./BindingHttp.ts";
import { CloseAllConnections } from "./CloseAllConnections.ts";

/**
 * Implementation of {@link CloseAllConnections} over the distilled `webpubsub-data`
 * data plane. Assigns the custom `AzureWebPubSubConnectionWriteRole` on the hub's
 * service.
 *
 * @layer
 * @provides Azure.WebPubSub.CloseAllConnections
 */
export const CloseAllConnectionsHttp = Layer.effect(
  CloseAllConnections,
  makeHubOperationBinding({
    tag: "Azure.WebPubSub.CloseAllConnections",
    operation: webpubsub.CloseAllConnections,
    grant: WebPubSubRole.ConnectionWrite,
  }),
);
