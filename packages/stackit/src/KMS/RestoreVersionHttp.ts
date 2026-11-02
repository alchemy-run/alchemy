import * as kms from "@distilled.cloud/stackit/kms";
import * as Layer from "effect/Layer";
import { KMS_WRITE_ACCESS, makeKeyHttpBinding } from "./BindingHttp.ts";
import { RestoreVersion } from "./RestoreVersion.ts";

/**
 * HTTP implementation of {@link RestoreVersion}.
 *
 * @layer
 * @provides Stackit.KMS.RestoreVersion
 */
export const RestoreVersionHttp = Layer.effect(
  RestoreVersion,
  makeKeyHttpBinding({
    tag: "Stackit.KMS.RestoreVersion",
    access: KMS_WRITE_ACCESS,
    operation: kms.restoreVersion,
  }),
);
