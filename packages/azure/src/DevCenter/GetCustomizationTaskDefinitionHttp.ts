import * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Layer from "effect/Layer";
import { makeProjectHttpBinding, DevCenterRole } from "./BindingHttp.ts";
import { GetCustomizationTaskDefinition } from "./GetCustomizationTaskDefinition.ts";

/**
 * Implementation of {@link GetCustomizationTaskDefinition} over the distilled
 * `devcenter-data` data plane. Assigns the custom
 * `AzureDevCenterCatalogReadRole` on the project.
 *
 * @layer
 * @provides Azure.DevCenter.GetCustomizationTaskDefinition
 */
export const GetCustomizationTaskDefinitionHttp = Layer.effect(
  GetCustomizationTaskDefinition,
  makeProjectHttpBinding({
    tag: "Azure.DevCenter.GetCustomizationTaskDefinition",
    operation: devcenter.GetDevBoxCustomizationTaskDefinitions,
    grants: [DevCenterRole.CatalogRead],
  }),
);
