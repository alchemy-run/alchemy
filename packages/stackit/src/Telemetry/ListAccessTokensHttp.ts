import * as router from "@distilled.cloud/stackit/telemetry_router";
import * as Layer from "effect/Layer";
import { makeRouterHttpBinding } from "./BindingHttp.ts";
import { ListAccessTokens } from "./ListAccessTokens.ts";

/**
 * HTTP implementation of {@link ListAccessTokens}.
 *
 * @layer
 * @provides Stackit.Telemetry.ListAccessTokens
 */
export const ListAccessTokensHttp = Layer.effect(
  ListAccessTokens,
  makeRouterHttpBinding({
    tag: "Stackit.Telemetry.ListAccessTokens",
    permission: "telemetry-router.access-token.list",
    operation: router.listAccessTokens,
  }),
);
