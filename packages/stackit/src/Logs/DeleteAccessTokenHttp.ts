import * as logs from "@distilled.cloud/stackit/logs";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { DeleteAccessToken } from "./DeleteAccessToken.ts";

/**
 * HTTP implementation of {@link DeleteAccessToken}.
 *
 * @layer
 * @provides Stackit.Logs.DeleteAccessToken
 */
export const DeleteAccessTokenHttp = Layer.effect(
  DeleteAccessToken,
  makeInstanceHttpBinding({
    tag: "Stackit.Logs.DeleteAccessToken",
    permission: "logs.instance.credentials.delete",
    operation: logs.deleteAccessToken,
  }),
);
