import * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Layer from "effect/Layer";
import { makeProjectUserHttpBinding, DevCenterRole } from "./BindingHttp.ts";
import { DelayDevBoxAction } from "./DelayDevBoxAction.ts";

/**
 * Implementation of {@link DelayDevBoxAction} over the distilled
 * `devcenter-data` data plane. Assigns the custom
 * `AzureDevCenterDevBoxActionManageRole` on the project.
 *
 * @layer
 * @provides Azure.DevCenter.DelayDevBoxAction
 */
export const DelayDevBoxActionHttp = Layer.effect(
  DelayDevBoxAction,
  makeProjectUserHttpBinding({
    tag: "Azure.DevCenter.DelayDevBoxAction",
    operation: devcenter.DevBoxesDelayAction,
    grants: [DevCenterRole.DevBoxActionManage],
  }),
);
