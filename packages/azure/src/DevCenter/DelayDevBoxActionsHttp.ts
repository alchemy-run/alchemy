import * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Layer from "effect/Layer";
import { makeProjectUserHttpBinding, DevCenterRole } from "./BindingHttp.ts";
import { DelayDevBoxActions } from "./DelayDevBoxActions.ts";

/**
 * Implementation of {@link DelayDevBoxActions} over the distilled
 * `devcenter-data` data plane. Assigns the custom
 * `AzureDevCenterDevBoxActionManageRole` on the project.
 *
 * @layer
 * @provides Azure.DevCenter.DelayDevBoxActions
 */
export const DelayDevBoxActionsHttp = Layer.effect(
  DelayDevBoxActions,
  makeProjectUserHttpBinding({
    tag: "Azure.DevCenter.DelayDevBoxActions",
    operation: devcenter.DevBoxesDelayActions,
    grants: [DevCenterRole.DevBoxActionManage],
  }),
);
