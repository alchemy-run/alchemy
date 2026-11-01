import * as kv from "@distilled.cloud/stackit/secrets_manager_kv";
import * as Layer from "effect/Layer";
import { makeVaultOperationBinding } from "./BindingHttp.ts";
import { GetSecret } from "./GetSecret.ts";

/**
 * HTTP implementation of {@link GetSecret}.
 *
 * @layer
 * @provides Stackit.SecretsManager.GetSecret
 */
export const GetSecretHttp = Layer.effect(
  GetSecret,
  makeVaultOperationBinding({
    tag: "Stackit.SecretsManager.GetSecret",
    write: false,
    operation: kv.getSecret,
  }),
);
