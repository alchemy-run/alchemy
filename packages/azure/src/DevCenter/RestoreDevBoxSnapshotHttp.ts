import * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Layer from "effect/Layer";
import { makeProjectUserHttpBinding, DevCenterRole } from "./BindingHttp.ts";
import { RestoreDevBoxSnapshot } from "./RestoreDevBoxSnapshot.ts";

/**
 * Implementation of {@link RestoreDevBoxSnapshot} over the distilled
 * `devcenter-data` data plane. Assigns the custom
 * `AzureDevCenterDevBoxManageRole` on the project.
 *
 * @layer
 * @provides Azure.DevCenter.RestoreDevBoxSnapshot
 */
export const RestoreDevBoxSnapshotHttp = Layer.effect(
  RestoreDevBoxSnapshot,
  makeProjectUserHttpBinding({
    tag: "Azure.DevCenter.RestoreDevBoxSnapshot",
    operation: devcenter.RestoreDevBoxSnapshot,
    grants: [DevCenterRole.DevBoxManage],
  }),
);
