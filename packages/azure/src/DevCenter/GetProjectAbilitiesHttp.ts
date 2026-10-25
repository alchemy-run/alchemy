import * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Layer from "effect/Layer";
import { makeProjectUserHttpBinding, DevCenterRole } from "./BindingHttp.ts";
import { GetProjectAbilities } from "./GetProjectAbilities.ts";

/**
 * Implementation of {@link GetProjectAbilities} over the distilled
 * `devcenter-data` data plane. Assigns the custom
 * `AzureDevCenterProjectReadRole` on the project.
 *
 * @layer
 * @provides Azure.DevCenter.GetProjectAbilities
 */
export const GetProjectAbilitiesHttp = Layer.effect(
  GetProjectAbilities,
  makeProjectUserHttpBinding({
    tag: "Azure.DevCenter.GetProjectAbilities",
    operation: devcenter.GetDevCenterProjectAbilities,
    grants: [DevCenterRole.ProjectRead],
  }),
);
