import * as webpubsub from "@distilled.cloud/azure/webpubsub-data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeHubOperationBinding, WebPubSubRole } from "./BindingHttp.ts";
import { CheckPermission } from "./CheckPermission.ts";

/**
 * Implementation of {@link CheckPermission} over the distilled `webpubsub-data`
 * data plane. Assigns the custom `AzureWebPubSubConnectionReadRole` on the hub's
 * service.
 *
 * @layer
 * @provides Azure.WebPubSub.CheckPermission
 */
export const CheckPermissionHttp = Layer.effect(
  CheckPermission,
  makeHubOperationBinding({
    tag: "Azure.WebPubSub.CheckPermission",
    operation: webpubsub.CheckPermission,
    grant: WebPubSubRole.ConnectionRead,
    // The service answers 404 for `false`.
    finish: (check) =>
      check.pipe(
        Effect.as(true),
        Effect.catchTag("WebPubSubPermissionNotGranted", () => Effect.succeed(false)),
      ),
  }),
);
