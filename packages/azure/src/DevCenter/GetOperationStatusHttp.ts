import * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Layer from "effect/Layer";
import { makeProjectHttpBinding, DevCenterRole } from "./BindingHttp.ts";
import { GetOperationStatus } from "./GetOperationStatus.ts";

/**
 * Implementation of {@link GetOperationStatus} over the distilled
 * `devcenter-data` data plane. Assigns the custom
 * `AzureDevCenterProjectReadRole` on the project.
 *
 * @layer
 * @provides Azure.DevCenter.GetOperationStatus
 */
export const GetOperationStatusHttp = Layer.effect(
  GetOperationStatus,
  makeProjectHttpBinding({
    tag: "Azure.DevCenter.GetOperationStatus",
    operation: devcenter.GetOperationStatus,
    grants: [DevCenterRole.ProjectRead],
  }),
);
