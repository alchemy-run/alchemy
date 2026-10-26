import * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Layer from "effect/Layer";
import { makeProjectHttpBinding, DevCenterRole } from "./BindingHttp.ts";
import { ValidateCustomizationTasks } from "./ValidateCustomizationTasks.ts";

/**
 * Implementation of {@link ValidateCustomizationTasks} over the distilled
 * `devcenter-data` data plane. Assigns the custom
 * `AzureDevCenterDevBoxCustomizeRole` on the project.
 *
 * @layer
 * @provides Azure.DevCenter.ValidateCustomizationTasks
 */
export const ValidateCustomizationTasksHttp = Layer.effect(
  ValidateCustomizationTasks,
  makeProjectHttpBinding({
    tag: "Azure.DevCenter.ValidateCustomizationTasks",
    operation: devcenter.ValidateDevBoxCustomizationTasksAction,
    grants: [DevCenterRole.DevBoxCustomize],
  }),
);
