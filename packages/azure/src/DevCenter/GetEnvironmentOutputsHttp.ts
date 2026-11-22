import * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Layer from "effect/Layer";
import { makeProjectUserHttpBinding, DevCenterRole } from "./BindingHttp.ts";
import { GetEnvironmentOutputs } from "./GetEnvironmentOutputs.ts";

/**
 * Implementation of {@link GetEnvironmentOutputs} over the distilled
 * `devcenter-data` data plane. Assigns the custom
 * `AzureDevCenterEnvironmentOutputsReadRole` on the project.
 *
 * @layer
 * @provides Azure.DevCenter.GetEnvironmentOutputs
 */
export const GetEnvironmentOutputsHttp = Layer.effect(
  GetEnvironmentOutputs,
  makeProjectUserHttpBinding({
    tag: "Azure.DevCenter.GetEnvironmentOutputs",
    operation: devcenter.GetEnvironmentOutputs,
    grants: [DevCenterRole.EnvironmentOutputsRead],
  }),
);
