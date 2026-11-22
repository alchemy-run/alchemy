import * as webpubsub from "@distilled.cloud/azure/webpubsub-data";
import * as Layer from "effect/Layer";
import { makeHubOperationBinding, WebPubSubRole } from "./BindingHttp.ts";
import { CloseConnection } from "./CloseConnection.ts";

/**
 * Implementation of {@link CloseConnection} over the distilled `webpubsub-data`
 * data plane. Assigns the custom `AzureWebPubSubConnectionWriteRole` on the hub's
 * service.
 *
 * @layer
 * @provides Azure.WebPubSub.CloseConnection
 */
export const CloseConnectionHttp = Layer.effect(
  CloseConnection,
  makeHubOperationBinding({
    tag: "Azure.WebPubSub.CloseConnection",
    operation: webpubsub.CloseConnection,
    grant: WebPubSubRole.ConnectionWrite,
  }),
);
