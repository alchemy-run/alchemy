import * as Layer from "effect/Layer";
import { KMS_READ_ACCESS, makeKeyClientHttpBinding, makeDecryptClient } from "./BindingHttp.ts";
import { Decrypt } from "./Decrypt.ts";

/**
 * HTTP implementation of {@link Decrypt}.
 *
 * @layer
 * @provides Stackit.KMS.Decrypt
 */
export const DecryptHttp = Layer.effect(
  Decrypt,
  makeKeyClientHttpBinding({
    tag: "Stackit.KMS.Decrypt",
    access: KMS_READ_ACCESS,
    makeClient: makeDecryptClient,
  }),
);
