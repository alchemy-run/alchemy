import * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Layer from "effect/Layer";
import { makeProjectHttpBinding, DevCenterRole } from "./BindingHttp.ts";
import { ListCustomizationTaskDefinitions } from "./ListCustomizationTaskDefinitions.ts";

/**
 * Implementation of {@link ListCustomizationTaskDefinitions} over the distilled
 * `devcenter-data` data plane. Assigns the custom
 * `AzureDevCenterCatalogReadRole` on the project.
 *
 * @layer
 * @provides Azure.DevCenter.ListCustomizationTaskDefinitions
 */
export const ListCustomizationTaskDefinitionsHttp = Layer.effect(
  ListCustomizationTaskDefinitions,
  makeProjectHttpBinding({
    tag: "Azure.DevCenter.ListCustomizationTaskDefinitions",
    operation: devcenter.ListDevBoxCustomizationTaskDefinitionsByProject,
    grants: [DevCenterRole.CatalogRead],
  }),
);
