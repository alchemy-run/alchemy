import * as webpubsub from "@distilled.cloud/azure/webpubsub-data";
import * as Layer from "effect/Layer";
import { makeHubOperationBinding, WebPubSubRole } from "./BindingHttp.ts";
import { GenerateClientToken } from "./GenerateClientToken.ts";

/**
 * Implementation of {@link GenerateClientToken} over the distilled `webpubsub-data`
 * data plane. Assigns the custom `AzureWebPubSubGenerateTokenRole` on the hub's
 * service.
 *
 * @layer
 * @provides Azure.WebPubSub.GenerateClientToken
 */
export const GenerateClientTokenHttp = Layer.effect(
  GenerateClientToken,
  makeHubOperationBinding({
    tag: "Azure.WebPubSub.GenerateClientToken",
    operation: webpubsub.GenerateClientToken,
    grant: WebPubSubRole.GenerateToken,
  }),
);
