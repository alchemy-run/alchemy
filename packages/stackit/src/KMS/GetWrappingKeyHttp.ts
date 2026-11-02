import * as kms from "@distilled.cloud/stackit/kms";
import * as Layer from "effect/Layer";
import { KMS_READ_ACCESS, makeWrappingKeyHttpBinding } from "./BindingHttp.ts";
import { GetWrappingKey } from "./GetWrappingKey.ts";

/**
 * HTTP implementation of {@link GetWrappingKey}.
 *
 * @layer
 * @provides Stackit.KMS.GetWrappingKey
 */
export const GetWrappingKeyHttp = Layer.effect(
  GetWrappingKey,
  makeWrappingKeyHttpBinding({
    tag: "Stackit.KMS.GetWrappingKey",
    access: KMS_READ_ACCESS,
    operation: kms.getWrappingKey,
  }),
);
