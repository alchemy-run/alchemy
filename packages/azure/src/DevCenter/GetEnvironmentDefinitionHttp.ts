import * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Layer from "effect/Layer";
import { makeProjectHttpBinding, DevCenterRole } from "./BindingHttp.ts";
import { GetEnvironmentDefinition } from "./GetEnvironmentDefinition.ts";

/**
 * Implementation of {@link GetEnvironmentDefinition} over the distilled
 * `devcenter-data` data plane. Assigns the custom
 * `AzureDevCenterEnvironmentDefinitionReadRole` on the project.
 *
 * @layer
 * @provides Azure.DevCenter.GetEnvironmentDefinition
 */
export const GetEnvironmentDefinitionHttp = Layer.effect(
  GetEnvironmentDefinition,
  makeProjectHttpBinding({
    tag: "Azure.DevCenter.GetEnvironmentDefinition",
    operation: devcenter.GetEnvironmentEnvironmentDefinition,
    grants: [DevCenterRole.EnvironmentDefinitionRead],
  }),
);
