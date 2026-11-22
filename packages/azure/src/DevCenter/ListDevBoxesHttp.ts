import * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Layer from "effect/Layer";
import { makeProjectUserHttpBinding, DevCenterRole } from "./BindingHttp.ts";
import { ListDevBoxes } from "./ListDevBoxes.ts";

/**
 * Implementation of {@link ListDevBoxes} over the distilled `devcenter-data`
 * data plane. Assigns the custom `AzureDevCenterDevBoxReadRole` on the
 * project.
 *
 * @layer
 * @provides Azure.DevCenter.ListDevBoxes
 */
export const ListDevBoxesHttp = Layer.effect(
  ListDevBoxes,
  makeProjectUserHttpBinding({
    tag: "Azure.DevCenter.ListDevBoxes",
    operation: devcenter.ListDevBoxDevBoxesByUser,
    grants: [DevCenterRole.DevBoxRead],
  }),
);
