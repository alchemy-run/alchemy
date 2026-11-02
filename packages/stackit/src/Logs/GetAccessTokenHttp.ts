import * as logs from "@distilled.cloud/stackit/logs";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetAccessToken } from "./GetAccessToken.ts";

/**
 * HTTP implementation of {@link GetAccessToken}.
 *
 * @layer
 * @provides Stackit.Logs.GetAccessToken
 */
export const GetAccessTokenHttp = Layer.effect(
  GetAccessToken,
  makeInstanceHttpBinding({
    tag: "Stackit.Logs.GetAccessToken",
    permission: "logs.instance.credentials.get",
    operation: logs.getAccessToken,
  }),
);
