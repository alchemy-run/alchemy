import * as webpubsub from "@distilled.cloud/azure/webpubsub-data";
import * as Layer from "effect/Layer";
import { makeHubOperationBinding, WebPubSubRole } from "./BindingHttp.ts";
import { CloseGroupConnections } from "./CloseGroupConnections.ts";

/**
 * Implementation of {@link CloseGroupConnections} over the distilled `webpubsub-data`
 * data plane. Assigns the custom `AzureWebPubSubConnectionWriteRole` on the hub's
 * service.
 *
 * @layer
 * @provides Azure.WebPubSub.CloseGroupConnections
 */
export const CloseGroupConnectionsHttp = Layer.effect(
  CloseGroupConnections,
  makeHubOperationBinding({
    tag: "Azure.WebPubSub.CloseGroupConnections",
    operation: webpubsub.CloseGroupConnections,
    grant: WebPubSubRole.ConnectionWrite,
  }),
);
