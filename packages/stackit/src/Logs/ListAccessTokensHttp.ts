import * as logs from "@distilled.cloud/stackit/logs";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListAccessTokens } from "./ListAccessTokens.ts";

/**
 * HTTP implementation of {@link ListAccessTokens}.
 *
 * @layer
 * @provides Stackit.Logs.ListAccessTokens
 */
export const ListAccessTokensHttp = Layer.effect(
  ListAccessTokens,
  makeInstanceHttpBinding({
    tag: "Stackit.Logs.ListAccessTokens",
    permission: "logs.instance.credentials.list",
    operation: logs.listAccessTokens,
  }),
);
