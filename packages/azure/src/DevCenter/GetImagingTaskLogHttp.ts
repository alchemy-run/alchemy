import * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Layer from "effect/Layer";
import { makeProjectHttpBinding, DevCenterRole } from "./BindingHttp.ts";
import { GetImagingTaskLog } from "./GetImagingTaskLog.ts";

/**
 * Implementation of {@link GetImagingTaskLog} over the distilled
 * `devcenter-data` data plane. Assigns the custom
 * `AzureDevCenterImageBuildReadRole` on the project.
 *
 * @layer
 * @provides Azure.DevCenter.GetImagingTaskLog
 */
export const GetImagingTaskLogHttp = Layer.effect(
  GetImagingTaskLog,
  makeProjectHttpBinding({
    tag: "Azure.DevCenter.GetImagingTaskLog",
    operation: devcenter.GetDevBoxImagingTaskLog,
    grants: [DevCenterRole.ImageBuildRead],
  }),
);
