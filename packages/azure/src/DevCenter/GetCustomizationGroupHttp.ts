import * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Layer from "effect/Layer";
import { makeProjectUserHttpBinding, DevCenterRole } from "./BindingHttp.ts";
import { GetCustomizationGroup } from "./GetCustomizationGroup.ts";

/**
 * Implementation of {@link GetCustomizationGroup} over the distilled
 * `devcenter-data` data plane. Assigns the custom
 * `AzureDevCenterDevBoxReadRole` on the project.
 *
 * @layer
 * @provides Azure.DevCenter.GetCustomizationGroup
 */
export const GetCustomizationGroupHttp = Layer.effect(
  GetCustomizationGroup,
  makeProjectUserHttpBinding({
    tag: "Azure.DevCenter.GetCustomizationGroup",
    operation: devcenter.GetDevBoxCustomizationGroup,
    grants: [DevCenterRole.DevBoxRead],
  }),
);
