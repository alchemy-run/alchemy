import * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Layer from "effect/Layer";
import { makeProjectUserHttpBinding, DevCenterRole } from "./BindingHttp.ts";
import { GetDevBoxSnapshot } from "./GetDevBoxSnapshot.ts";

/**
 * Implementation of {@link GetDevBoxSnapshot} over the distilled
 * `devcenter-data` data plane. Assigns the custom
 * `AzureDevCenterDevBoxReadRole` on the project.
 *
 * @layer
 * @provides Azure.DevCenter.GetDevBoxSnapshot
 */
export const GetDevBoxSnapshotHttp = Layer.effect(
  GetDevBoxSnapshot,
  makeProjectUserHttpBinding({
    tag: "Azure.DevCenter.GetDevBoxSnapshot",
    operation: devcenter.GetDevBoxSnapshot,
    grants: [DevCenterRole.DevBoxRead],
  }),
);
