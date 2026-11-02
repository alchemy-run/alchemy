import * as router from "@distilled.cloud/stackit/telemetry_router";
import * as Layer from "effect/Layer";
import { makeAccessTokenHttpBinding } from "./BindingHttp.ts";
import { GetAccessToken } from "./GetAccessToken.ts";

/**
 * HTTP implementation of {@link GetAccessToken}.
 *
 * @layer
 * @provides Stackit.Telemetry.GetAccessToken
 */
export const GetAccessTokenHttp = Layer.effect(
  GetAccessToken,
  makeAccessTokenHttpBinding({
    tag: "Stackit.Telemetry.GetAccessToken",
    permission: "telemetry-router.access-token.get",
    operation: router.getAccessToken,
  }),
);
