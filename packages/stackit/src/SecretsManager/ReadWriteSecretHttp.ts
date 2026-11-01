import * as Layer from "effect/Layer";
import { makeReadWriteSecretClient, makeVaultClientBinding } from "./BindingHttp.ts";
import { ReadWriteSecret } from "./ReadWriteSecret.ts";

/**
 * HTTP implementation of {@link ReadWriteSecret}.
 *
 * @layer
 * @provides Stackit.SecretsManager.ReadWriteSecret
 */
export const ReadWriteSecretHttp = Layer.effect(
  ReadWriteSecret,
  makeVaultClientBinding({
    tag: "Stackit.SecretsManager.ReadWriteSecret",
    write: true,
    makeClient: makeReadWriteSecretClient,
  }),
);
