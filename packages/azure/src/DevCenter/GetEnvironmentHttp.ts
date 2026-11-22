import * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Layer from "effect/Layer";
import { makeProjectUserHttpBinding, DevCenterRole } from "./BindingHttp.ts";
import { GetEnvironment } from "./GetEnvironment.ts";

/**
 * Implementation of {@link GetEnvironment} over the distilled
 * `devcenter-data` data plane. Assigns the custom
 * `AzureDevCenterEnvironmentReadRole` on the project.
 *
 * @layer
 * @provides Azure.DevCenter.GetEnvironment
 */
export const GetEnvironmentHttp = Layer.effect(
  GetEnvironment,
  makeProjectUserHttpBinding({
    tag: "Azure.DevCenter.GetEnvironment",
    operation: devcenter.GetEnvironmentEnvironmentByUser,
    grants: [DevCenterRole.EnvironmentRead],
  }),
);
