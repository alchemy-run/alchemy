import * as kms from "@distilled.cloud/stackit/kms";
import * as Layer from "effect/Layer";
import { KMS_READ_ACCESS, makeKeyRingHttpBinding } from "./BindingHttp.ts";
import { GetKeyRing } from "./GetKeyRing.ts";

/**
 * HTTP implementation of {@link GetKeyRing}.
 *
 * @layer
 * @provides Stackit.KMS.GetKeyRing
 */
export const GetKeyRingHttp = Layer.effect(
  GetKeyRing,
  makeKeyRingHttpBinding({
    tag: "Stackit.KMS.GetKeyRing",
    access: KMS_READ_ACCESS,
    operation: kms.getKeyRing,
  }),
);
