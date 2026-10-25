import * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Layer from "effect/Layer";
import { makeProjectUserHttpBinding, DevCenterRole } from "./BindingHttp.ts";
import { StartDevBox } from "./StartDevBox.ts";

/**
 * Implementation of {@link StartDevBox} over the distilled `devcenter-data`
 * data plane. Assigns the custom `AzureDevCenterDevBoxStartRole` on the
 * project.
 *
 * @layer
 * @provides Azure.DevCenter.StartDevBox
 */
export const StartDevBoxHttp = Layer.effect(
  StartDevBox,
  makeProjectUserHttpBinding({
    tag: "Azure.DevCenter.StartDevBox",
    operation: devcenter.StartDevBoxDevBox,
    grants: [DevCenterRole.DevBoxStart],
  }),
);
