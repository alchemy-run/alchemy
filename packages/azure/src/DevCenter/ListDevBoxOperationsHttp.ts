import * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Layer from "effect/Layer";
import { makeProjectUserHttpBinding, DevCenterRole } from "./BindingHttp.ts";
import { ListDevBoxOperations } from "./ListDevBoxOperations.ts";

/**
 * Implementation of {@link ListDevBoxOperations} over the distilled
 * `devcenter-data` data plane. Assigns the custom
 * `AzureDevCenterDevBoxReadRole` on the project.
 *
 * @layer
 * @provides Azure.DevCenter.ListDevBoxOperations
 */
export const ListDevBoxOperationsHttp = Layer.effect(
  ListDevBoxOperations,
  makeProjectUserHttpBinding({
    tag: "Azure.DevCenter.ListDevBoxOperations",
    operation: devcenter.ListDevBoxOperations,
    grants: [DevCenterRole.DevBoxRead],
  }),
);
