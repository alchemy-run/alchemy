import * as secretsManager from "@distilled.cloud/stackit/secrets_manager";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetUser } from "./GetUser.ts";

/**
 * HTTP implementation of {@link GetUser}.
 *
 * @layer
 * @provides Stackit.SecretsManager.GetUser
 */
export const GetUserHttp = Layer.effect(
  GetUser,
  makeInstanceHttpBinding({
    tag: "Stackit.SecretsManager.GetUser",
    operation: secretsManager.getUser,
  }),
);
