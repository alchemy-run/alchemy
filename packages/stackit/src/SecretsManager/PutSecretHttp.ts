import * as kv from "@distilled.cloud/stackit/secrets_manager_kv";
import * as Layer from "effect/Layer";
import { makeVaultOperationBinding } from "./BindingHttp.ts";
import { PutSecret } from "./PutSecret.ts";

/**
 * HTTP implementation of {@link PutSecret}.
 *
 * @layer
 * @provides Stackit.SecretsManager.PutSecret
 */
export const PutSecretHttp = Layer.effect(
  PutSecret,
  makeVaultOperationBinding({
    tag: "Stackit.SecretsManager.PutSecret",
    write: true,
    operation: kv.putSecret,
  }),
);
