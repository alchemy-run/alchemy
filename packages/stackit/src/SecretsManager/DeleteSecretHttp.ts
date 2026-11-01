import * as Layer from "effect/Layer";
import { makeDeleteSecretClient, makeVaultClientBinding } from "./BindingHttp.ts";
import { DeleteSecret } from "./DeleteSecret.ts";

/**
 * HTTP implementation of {@link DeleteSecret}.
 *
 * @layer
 * @provides Stackit.SecretsManager.DeleteSecret
 */
export const DeleteSecretHttp = Layer.effect(
  DeleteSecret,
  makeVaultClientBinding({
    tag: "Stackit.SecretsManager.DeleteSecret",
    write: true,
    makeClient: makeDeleteSecretClient,
  }),
);
