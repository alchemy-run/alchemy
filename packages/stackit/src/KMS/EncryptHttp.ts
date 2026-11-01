import * as Layer from "effect/Layer";
import { KMS_READ_ACCESS, makeKeyClientHttpBinding, makeEncryptClient } from "./BindingHttp.ts";
import { Encrypt } from "./Encrypt.ts";

/**
 * HTTP implementation of {@link Encrypt}.
 *
 * @layer
 * @provides Stackit.KMS.Encrypt
 */
export const EncryptHttp = Layer.effect(
  Encrypt,
  makeKeyClientHttpBinding({
    tag: "Stackit.KMS.Encrypt",
    access: KMS_READ_ACCESS,
    makeClient: makeEncryptClient,
  }),
);
