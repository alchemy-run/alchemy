import * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Layer from "effect/Layer";
import { makeProjectUserHttpBinding, DevCenterRole } from "./BindingHttp.ts";
import { CreateCustomizationGroup } from "./CreateCustomizationGroup.ts";

/**
 * Implementation of {@link CreateCustomizationGroup} over the distilled
 * `devcenter-data` data plane. Assigns the custom
 * `AzureDevCenterDevBoxCustomizeRole` on the project.
 *
 * @layer
 * @provides Azure.DevCenter.CreateCustomizationGroup
 */
export const CreateCustomizationGroupHttp = Layer.effect(
  CreateCustomizationGroup,
  makeProjectUserHttpBinding({
    tag: "Azure.DevCenter.CreateCustomizationGroup",
    operation: devcenter.CreateDevBoxCustomizationGroup,
    grants: [DevCenterRole.DevBoxCustomize],
  }),
);
