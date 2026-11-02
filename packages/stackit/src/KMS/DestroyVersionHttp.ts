import * as kms from "@distilled.cloud/stackit/kms";
import * as Layer from "effect/Layer";
import { KMS_WRITE_ACCESS, makeKeyHttpBinding } from "./BindingHttp.ts";
import { DestroyVersion } from "./DestroyVersion.ts";

/**
 * HTTP implementation of {@link DestroyVersion}.
 *
 * @layer
 * @provides Stackit.KMS.DestroyVersion
 */
export const DestroyVersionHttp = Layer.effect(
  DestroyVersion,
  makeKeyHttpBinding({
    tag: "Stackit.KMS.DestroyVersion",
    access: KMS_WRITE_ACCESS,
    operation: kms.destroyVersion,
  }),
);
