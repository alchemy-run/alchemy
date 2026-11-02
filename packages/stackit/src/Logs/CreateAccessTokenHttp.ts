import * as logs from "@distilled.cloud/stackit/logs";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { CreateAccessToken } from "./CreateAccessToken.ts";

/**
 * HTTP implementation of {@link CreateAccessToken}.
 *
 * @layer
 * @provides Stackit.Logs.CreateAccessToken
 */
export const CreateAccessTokenHttp = Layer.effect(
  CreateAccessToken,
  makeInstanceHttpBinding({
    tag: "Stackit.Logs.CreateAccessToken",
    permission: "logs.instance.credentials.create",
    operation: logs.createAccessToken,
  }),
);
