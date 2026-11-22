import * as webpubsub from "@distilled.cloud/azure/webpubsub-data";
import * as Layer from "effect/Layer";
import { makeHubOperationBinding, WebPubSubRole } from "./BindingHttp.ts";
import { RevokePermission } from "./RevokePermission.ts";

/**
 * Implementation of {@link RevokePermission} over the distilled `webpubsub-data`
 * data plane. Assigns the custom `AzureWebPubSubConnectionWriteRole` on the hub's
 * service.
 *
 * @layer
 * @provides Azure.WebPubSub.RevokePermission
 */
export const RevokePermissionHttp = Layer.effect(
  RevokePermission,
  makeHubOperationBinding({
    tag: "Azure.WebPubSub.RevokePermission",
    operation: webpubsub.RevokePermission,
    grant: WebPubSubRole.ConnectionWrite,
  }),
);
