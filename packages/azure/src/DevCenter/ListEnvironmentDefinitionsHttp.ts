import * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Layer from "effect/Layer";
import { makeProjectHttpBinding, DevCenterRole } from "./BindingHttp.ts";
import { ListEnvironmentDefinitions } from "./ListEnvironmentDefinitions.ts";

/**
 * Implementation of {@link ListEnvironmentDefinitions} over the distilled
 * `devcenter-data` data plane. Assigns the custom
 * `AzureDevCenterEnvironmentDefinitionReadRole` on the project.
 *
 * @layer
 * @provides Azure.DevCenter.ListEnvironmentDefinitions
 */
export const ListEnvironmentDefinitionsHttp = Layer.effect(
  ListEnvironmentDefinitions,
  makeProjectHttpBinding({
    tag: "Azure.DevCenter.ListEnvironmentDefinitions",
    operation: devcenter.ListEnvironmentEnvironmentDefinitionsByProject,
    grants: [DevCenterRole.EnvironmentDefinitionRead],
  }),
);
