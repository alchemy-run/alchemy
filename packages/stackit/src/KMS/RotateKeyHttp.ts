import * as kms from "@distilled.cloud/stackit/kms";
import * as Layer from "effect/Layer";
import { KMS_WRITE_ACCESS, makeKeyHttpBinding } from "./BindingHttp.ts";
import { RotateKey } from "./RotateKey.ts";

/**
 * HTTP implementation of {@link RotateKey}.
 *
 * @layer
 * @provides Stackit.KMS.RotateKey
 */
export const RotateKeyHttp = Layer.effect(
  RotateKey,
  makeKeyHttpBinding({
    tag: "Stackit.KMS.RotateKey",
    access: KMS_WRITE_ACCESS,
    operation: kms.rotateKey,
  }),
);
