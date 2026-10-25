import * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Layer from "effect/Layer";
import { makeProjectUserHttpBinding, DevCenterRole } from "./BindingHttp.ts";
import { DeleteDevBox } from "./DeleteDevBox.ts";

/**
 * Implementation of {@link DeleteDevBox} over the distilled `devcenter-data`
 * data plane. Assigns the custom `AzureDevCenterDevBoxDeleteRole` on the
 * project.
 *
 * @layer
 * @provides Azure.DevCenter.DeleteDevBox
 */
export const DeleteDevBoxHttp = Layer.effect(
  DeleteDevBox,
  makeProjectUserHttpBinding({
    tag: "Azure.DevCenter.DeleteDevBox",
    operation: devcenter.DeleteDevBoxDevBox,
    grants: [DevCenterRole.DevBoxDelete],
  }),
);
