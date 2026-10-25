import * as webpubsub from "@distilled.cloud/azure/webpubsub-data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeHubOperationBinding, WebPubSubRole } from "./BindingHttp.ts";
import { UserExists } from "./UserExists.ts";

/**
 * Implementation of {@link UserExists} over the distilled `webpubsub-data`
 * data plane. Assigns the custom `AzureWebPubSubUserReadRole` on the hub's
 * service.
 *
 * @layer
 * @provides Azure.WebPubSub.UserExists
 */
export const UserExistsHttp = Layer.effect(
  UserExists,
  makeHubOperationBinding({
    tag: "Azure.WebPubSub.UserExists",
    operation: webpubsub.UserExists,
    grant: WebPubSubRole.UserRead,
    // The service answers 404 for `false`.
    finish: (check) =>
      check.pipe(
        Effect.as(true),
        Effect.catchTag("WebPubSubUserNotFound", () => Effect.succeed(false)),
      ),
  }),
);
