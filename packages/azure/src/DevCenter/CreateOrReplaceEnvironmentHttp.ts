import * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Layer from "effect/Layer";
import { makeProjectUserHttpBinding, DevCenterRole } from "./BindingHttp.ts";
import { CreateOrReplaceEnvironment } from "./CreateOrReplaceEnvironment.ts";

/**
 * Implementation of {@link CreateOrReplaceEnvironment} over the distilled
 * `devcenter-data` data plane. Assigns the custom
 * `AzureDevCenterEnvironmentWriteRole` on the project.
 *
 * @layer
 * @provides Azure.DevCenter.CreateOrReplaceEnvironment
 */
export const CreateOrReplaceEnvironmentHttp = Layer.effect(
  CreateOrReplaceEnvironment,
  makeProjectUserHttpBinding({
    tag: "Azure.DevCenter.CreateOrReplaceEnvironment",
    operation: devcenter.EnvironmentsCreateOrReplaceEnvironment,
    grants: [DevCenterRole.EnvironmentWrite],
  }),
);
