import * as logs from "@distilled.cloud/stackit/logs";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { DeleteExpiredAccessTokens } from "./DeleteExpiredAccessTokens.ts";

/**
 * HTTP implementation of {@link DeleteExpiredAccessTokens}.
 *
 * @layer
 * @provides Stackit.Logs.DeleteExpiredAccessTokens
 */
export const DeleteExpiredAccessTokensHttp = Layer.effect(
  DeleteExpiredAccessTokens,
  makeInstanceHttpBinding({
    tag: "Stackit.Logs.DeleteExpiredAccessTokens",
    permission: "logs.instance.credentials.delete",
    operation: logs.deleteAllExpiredAccessTokens,
  }),
);
