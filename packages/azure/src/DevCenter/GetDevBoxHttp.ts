import * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Layer from "effect/Layer";
import { makeProjectUserHttpBinding, DevCenterRole } from "./BindingHttp.ts";
import { GetDevBox } from "./GetDevBox.ts";

/**
 * Implementation of {@link GetDevBox} over the distilled `devcenter-data`
 * data plane. Assigns the custom `AzureDevCenterDevBoxReadRole` on the
 * project.
 *
 * @layer
 * @provides Azure.DevCenter.GetDevBox
 */
export const GetDevBoxHttp = Layer.effect(
  GetDevBox,
  makeProjectUserHttpBinding({
    tag: "Azure.DevCenter.GetDevBox",
    operation: devcenter.GetDevBoxDevBoxByUser,
    grants: [DevCenterRole.DevBoxRead],
  }),
);
