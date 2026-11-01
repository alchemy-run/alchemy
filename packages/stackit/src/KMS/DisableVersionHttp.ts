import * as kms from "@distilled.cloud/stackit/kms";
import * as Layer from "effect/Layer";
import { KMS_WRITE_ACCESS, makeKeyHttpBinding } from "./BindingHttp.ts";
import { DisableVersion } from "./DisableVersion.ts";

/**
 * HTTP implementation of {@link DisableVersion}.
 *
 * @layer
 * @provides Stackit.KMS.DisableVersion
 */
export const DisableVersionHttp = Layer.effect(
  DisableVersion,
  makeKeyHttpBinding({
    tag: "Stackit.KMS.DisableVersion",
    access: KMS_WRITE_ACCESS,
    operation: kms.disableVersion,
  }),
);
