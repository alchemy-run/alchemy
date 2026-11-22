import * as webpubsub from "@distilled.cloud/azure/webpubsub-data";
import * as Layer from "effect/Layer";
import { makeHubOperationBinding, WebPubSubRole } from "./BindingHttp.ts";
import { CloseUserConnections } from "./CloseUserConnections.ts";

/**
 * Implementation of {@link CloseUserConnections} over the distilled `webpubsub-data`
 * data plane. Assigns the custom `AzureWebPubSubConnectionWriteRole` on the hub's
 * service.
 *
 * @layer
 * @provides Azure.WebPubSub.CloseUserConnections
 */
export const CloseUserConnectionsHttp = Layer.effect(
  CloseUserConnections,
  makeHubOperationBinding({
    tag: "Azure.WebPubSub.CloseUserConnections",
    operation: webpubsub.CloseUserConnections,
    grant: WebPubSubRole.ConnectionWrite,
  }),
);
