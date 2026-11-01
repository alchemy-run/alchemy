import * as Layer from "effect/Layer";
import { KMS_READ_ACCESS, makeKeyClientHttpBinding, makeVerifyClient } from "./BindingHttp.ts";
import { Verify } from "./Verify.ts";

/**
 * HTTP implementation of {@link Verify}.
 *
 * @layer
 * @provides Stackit.KMS.Verify
 */
export const VerifyHttp = Layer.effect(
  Verify,
  makeKeyClientHttpBinding({
    tag: "Stackit.KMS.Verify",
    access: KMS_READ_ACCESS,
    makeClient: makeVerifyClient,
  }),
);
