import * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Layer from "effect/Layer";
import { makeProjectUserHttpBinding, DevCenterRole } from "./BindingHttp.ts";
import { StopDevBox } from "./StopDevBox.ts";

/**
 * Implementation of {@link StopDevBox} over the distilled `devcenter-data`
 * data plane. Assigns the custom `AzureDevCenterDevBoxStopRole` on the
 * project.
 *
 * @layer
 * @provides Azure.DevCenter.StopDevBox
 */
export const StopDevBoxHttp = Layer.effect(
  StopDevBox,
  makeProjectUserHttpBinding({
    tag: "Azure.DevCenter.StopDevBox",
    operation: devcenter.StopDevBoxDevBox,
    grants: [DevCenterRole.DevBoxStop],
  }),
);
