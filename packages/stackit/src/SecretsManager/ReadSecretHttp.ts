import * as Layer from "effect/Layer";
import { makeReadSecretClient, makeVaultClientBinding } from "./BindingHttp.ts";
import { ReadSecret } from "./ReadSecret.ts";

/**
 * HTTP implementation of {@link ReadSecret}.
 *
 * @layer
 * @provides Stackit.SecretsManager.ReadSecret
 */
export const ReadSecretHttp = Layer.effect(
  ReadSecret,
  makeVaultClientBinding({
    tag: "Stackit.SecretsManager.ReadSecret",
    write: false,
    makeClient: makeReadSecretClient,
  }),
);
