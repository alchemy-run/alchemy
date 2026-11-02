import * as kms from "@distilled.cloud/stackit/kms";
import * as Layer from "effect/Layer";
import { KMS_READ_ACCESS, makeKeyHttpBinding } from "./BindingHttp.ts";
import { GetVersion } from "./GetVersion.ts";

/**
 * HTTP implementation of {@link GetVersion}.
 *
 * @layer
 * @provides Stackit.KMS.GetVersion
 */
export const GetVersionHttp = Layer.effect(
  GetVersion,
  makeKeyHttpBinding({
    tag: "Stackit.KMS.GetVersion",
    access: KMS_READ_ACCESS,
    operation: kms.getVersion,
  }),
);
