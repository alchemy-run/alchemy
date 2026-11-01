import * as kms from "@distilled.cloud/stackit/kms";
import * as Layer from "effect/Layer";
import { KMS_WRITE_ACCESS, makeKeyHttpBinding } from "./BindingHttp.ts";
import { EnableVersion } from "./EnableVersion.ts";

/**
 * HTTP implementation of {@link EnableVersion}.
 *
 * @layer
 * @provides Stackit.KMS.EnableVersion
 */
export const EnableVersionHttp = Layer.effect(
  EnableVersion,
  makeKeyHttpBinding({
    tag: "Stackit.KMS.EnableVersion",
    access: KMS_WRITE_ACCESS,
    operation: kms.enableVersion,
  }),
);
