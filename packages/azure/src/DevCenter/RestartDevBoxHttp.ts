import * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Layer from "effect/Layer";
import { makeProjectUserHttpBinding, DevCenterRole } from "./BindingHttp.ts";
import { RestartDevBox } from "./RestartDevBox.ts";

/**
 * Implementation of {@link RestartDevBox} over the distilled `devcenter-data`
 * data plane. Assigns the custom `AzureDevCenterDevBoxRestartRole` on the
 * project.
 *
 * @layer
 * @provides Azure.DevCenter.RestartDevBox
 */
export const RestartDevBoxHttp = Layer.effect(
  RestartDevBox,
  makeProjectUserHttpBinding({
    tag: "Azure.DevCenter.RestartDevBox",
    operation: devcenter.RestartDevBoxDevBox,
    grants: [DevCenterRole.DevBoxRestart],
  }),
);
