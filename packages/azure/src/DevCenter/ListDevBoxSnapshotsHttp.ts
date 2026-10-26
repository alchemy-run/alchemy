import * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Layer from "effect/Layer";
import { makeProjectUserHttpBinding, DevCenterRole } from "./BindingHttp.ts";
import { ListDevBoxSnapshots } from "./ListDevBoxSnapshots.ts";

/**
 * Implementation of {@link ListDevBoxSnapshots} over the distilled
 * `devcenter-data` data plane. Assigns the custom
 * `AzureDevCenterDevBoxReadRole` on the project.
 *
 * @layer
 * @provides Azure.DevCenter.ListDevBoxSnapshots
 */
export const ListDevBoxSnapshotsHttp = Layer.effect(
  ListDevBoxSnapshots,
  makeProjectUserHttpBinding({
    tag: "Azure.DevCenter.ListDevBoxSnapshots",
    operation: devcenter.ListDevBoxSnapshots,
    grants: [DevCenterRole.DevBoxRead],
  }),
);
