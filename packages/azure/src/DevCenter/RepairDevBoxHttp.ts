import * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Layer from "effect/Layer";
import { makeProjectUserHttpBinding, DevCenterRole } from "./BindingHttp.ts";
import { RepairDevBox } from "./RepairDevBox.ts";

/**
 * Implementation of {@link RepairDevBox} over the distilled `devcenter-data`
 * data plane. Assigns the custom `AzureDevCenterDevBoxManageRole` on the
 * project.
 *
 * @layer
 * @provides Azure.DevCenter.RepairDevBox
 */
export const RepairDevBoxHttp = Layer.effect(
  RepairDevBox,
  makeProjectUserHttpBinding({
    tag: "Azure.DevCenter.RepairDevBox",
    operation: devcenter.DevBoxesRepairDevBox,
    grants: [DevCenterRole.DevBoxManage],
  }),
);
