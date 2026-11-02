import * as Layer from "effect/Layer";
import { makeWriteSecretClient, makeVaultClientBinding } from "./BindingHttp.ts";
import { WriteSecret } from "./WriteSecret.ts";

/**
 * HTTP implementation of {@link WriteSecret}.
 *
 * @layer
 * @provides Stackit.SecretsManager.WriteSecret
 */
export const WriteSecretHttp = Layer.effect(
  WriteSecret,
  makeVaultClientBinding({
    tag: "Stackit.SecretsManager.WriteSecret",
    write: true,
    makeClient: makeWriteSecretClient,
  }),
);
