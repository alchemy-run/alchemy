import * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Layer from "effect/Layer";
import { makeProjectUserHttpBinding, DevCenterRole } from "./BindingHttp.ts";
import { ListCustomizationGroups } from "./ListCustomizationGroups.ts";

/**
 * Implementation of {@link ListCustomizationGroups} over the distilled
 * `devcenter-data` data plane. Assigns the custom
 * `AzureDevCenterDevBoxReadRole` on the project.
 *
 * @layer
 * @provides Azure.DevCenter.ListCustomizationGroups
 */
export const ListCustomizationGroupsHttp = Layer.effect(
  ListCustomizationGroups,
  makeProjectUserHttpBinding({
    tag: "Azure.DevCenter.ListCustomizationGroups",
    operation: devcenter.ListDevBoxCustomizationGroups,
    grants: [DevCenterRole.DevBoxRead],
  }),
);
