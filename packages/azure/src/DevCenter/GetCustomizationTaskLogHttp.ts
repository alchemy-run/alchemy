import * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Layer from "effect/Layer";
import { makeProjectUserHttpBinding, DevCenterRole } from "./BindingHttp.ts";
import { GetCustomizationTaskLog } from "./GetCustomizationTaskLog.ts";

/**
 * Implementation of {@link GetCustomizationTaskLog} over the distilled
 * `devcenter-data` data plane. Assigns the custom
 * `AzureDevCenterDevBoxReadRole` on the project.
 *
 * @layer
 * @provides Azure.DevCenter.GetCustomizationTaskLog
 */
export const GetCustomizationTaskLogHttp = Layer.effect(
  GetCustomizationTaskLog,
  makeProjectUserHttpBinding({
    tag: "Azure.DevCenter.GetCustomizationTaskLog",
    operation: devcenter.GetDevBoxCustomizationTaskLog,
    grants: [DevCenterRole.DevBoxRead],
  }),
);
