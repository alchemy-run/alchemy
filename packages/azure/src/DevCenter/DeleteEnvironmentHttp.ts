import * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Layer from "effect/Layer";
import { makeProjectUserHttpBinding, DevCenterRole } from "./BindingHttp.ts";
import { DeleteEnvironment } from "./DeleteEnvironment.ts";

/**
 * Implementation of {@link DeleteEnvironment} over the distilled
 * `devcenter-data` data plane. Assigns the custom
 * `AzureDevCenterEnvironmentDeleteRole` on the project.
 *
 * @layer
 * @provides Azure.DevCenter.DeleteEnvironment
 */
export const DeleteEnvironmentHttp = Layer.effect(
  DeleteEnvironment,
  makeProjectUserHttpBinding({
    tag: "Azure.DevCenter.DeleteEnvironment",
    operation: devcenter.DeleteEnvironmentEnvironment,
    grants: [DevCenterRole.EnvironmentDelete],
  }),
);
