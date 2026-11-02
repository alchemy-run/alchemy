import * as Layer from "effect/Layer";
import { KMS_READ_ACCESS, makeKeyClientHttpBinding, makeSignClient } from "./BindingHttp.ts";
import { Sign } from "./Sign.ts";

/**
 * HTTP implementation of {@link Sign}.
 *
 * @layer
 * @provides Stackit.KMS.Sign
 */
export const SignHttp = Layer.effect(
  Sign,
  makeKeyClientHttpBinding({
    tag: "Stackit.KMS.Sign",
    access: KMS_READ_ACCESS,
    makeClient: makeSignClient,
  }),
);
