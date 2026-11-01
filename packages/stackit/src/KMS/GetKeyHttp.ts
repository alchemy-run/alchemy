import * as kms from "@distilled.cloud/stackit/kms";
import * as Layer from "effect/Layer";
import { KMS_READ_ACCESS, makeKeyHttpBinding } from "./BindingHttp.ts";
import { GetKey } from "./GetKey.ts";

/**
 * HTTP implementation of {@link GetKey}.
 *
 * @layer
 * @provides Stackit.KMS.GetKey
 */
export const GetKeyHttp = Layer.effect(
  GetKey,
  makeKeyHttpBinding({
    tag: "Stackit.KMS.GetKey",
    access: KMS_READ_ACCESS,
    operation: kms.getKey,
  }),
);
