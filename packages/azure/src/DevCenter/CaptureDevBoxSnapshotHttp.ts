import * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Layer from "effect/Layer";
import { makeProjectUserHttpBinding, DevCenterRole } from "./BindingHttp.ts";
import { CaptureDevBoxSnapshot } from "./CaptureDevBoxSnapshot.ts";

/**
 * Implementation of {@link CaptureDevBoxSnapshot} over the distilled
 * `devcenter-data` data plane. Assigns the custom
 * `AzureDevCenterDevBoxManageRole` on the project.
 *
 * @layer
 * @provides Azure.DevCenter.CaptureDevBoxSnapshot
 */
export const CaptureDevBoxSnapshotHttp = Layer.effect(
  CaptureDevBoxSnapshot,
  makeProjectUserHttpBinding({
    tag: "Azure.DevCenter.CaptureDevBoxSnapshot",
    operation: devcenter.CaptureDevBoxSnapshot,
    grants: [DevCenterRole.DevBoxManage],
  }),
);
