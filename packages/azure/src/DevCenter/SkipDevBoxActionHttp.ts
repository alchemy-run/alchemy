import * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Layer from "effect/Layer";
import { makeProjectUserHttpBinding, DevCenterRole } from "./BindingHttp.ts";
import { SkipDevBoxAction } from "./SkipDevBoxAction.ts";

/**
 * Implementation of {@link SkipDevBoxAction} over the distilled
 * `devcenter-data` data plane. Assigns the custom
 * `AzureDevCenterDevBoxActionManageRole` on the project.
 *
 * @layer
 * @provides Azure.DevCenter.SkipDevBoxAction
 */
export const SkipDevBoxActionHttp = Layer.effect(
  SkipDevBoxAction,
  makeProjectUserHttpBinding({
    tag: "Azure.DevCenter.SkipDevBoxAction",
    operation: devcenter.DevBoxesSkipAction,
    grants: [DevCenterRole.DevBoxActionManage],
  }),
);
