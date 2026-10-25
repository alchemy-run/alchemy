import * as webpubsub from "@distilled.cloud/azure/webpubsub-data";
import * as Layer from "effect/Layer";
import { makeHubOperationBinding, WebPubSubRole } from "./BindingHttp.ts";
import { GrantPermission } from "./GrantPermission.ts";

/**
 * Implementation of {@link GrantPermission} over the distilled `webpubsub-data`
 * data plane. Assigns the custom `AzureWebPubSubConnectionWriteRole` on the hub's
 * service.
 *
 * @layer
 * @provides Azure.WebPubSub.GrantPermission
 */
export const GrantPermissionHttp = Layer.effect(
  GrantPermission,
  makeHubOperationBinding({
    tag: "Azure.WebPubSub.GrantPermission",
    operation: webpubsub.GrantPermission,
    grant: WebPubSubRole.ConnectionWrite,
  }),
);
