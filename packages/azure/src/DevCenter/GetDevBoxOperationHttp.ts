import * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Layer from "effect/Layer";
import { makeProjectUserHttpBinding, DevCenterRole } from "./BindingHttp.ts";
import { GetDevBoxOperation } from "./GetDevBoxOperation.ts";

/**
 * Implementation of {@link GetDevBoxOperation} over the distilled
 * `devcenter-data` data plane. Assigns the custom
 * `AzureDevCenterDevBoxReadRole` on the project.
 *
 * @layer
 * @provides Azure.DevCenter.GetDevBoxOperation
 */
export const GetDevBoxOperationHttp = Layer.effect(
  GetDevBoxOperation,
  makeProjectUserHttpBinding({
    tag: "Azure.DevCenter.GetDevBoxOperation",
    operation: devcenter.GetDevBoxOperation,
    grants: [DevCenterRole.DevBoxRead],
  }),
);
