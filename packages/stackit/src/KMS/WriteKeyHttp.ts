import * as Layer from "effect/Layer";
import { KMS_WRITE_ACCESS, makeKeyClientHttpBinding, makeWriteKeyClient } from "./BindingHttp.ts";
import { WriteKey } from "./WriteKey.ts";

/**
 * HTTP implementation of {@link WriteKey}.
 *
 * @layer
 * @provides Stackit.KMS.WriteKey
 */
export const WriteKeyHttp = Layer.effect(
  WriteKey,
  makeKeyClientHttpBinding({
    tag: "Stackit.KMS.WriteKey",
    access: KMS_WRITE_ACCESS,
    makeClient: makeWriteKeyClient,
  }),
);
