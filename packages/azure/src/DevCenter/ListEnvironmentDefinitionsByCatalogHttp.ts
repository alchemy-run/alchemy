import * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Layer from "effect/Layer";
import { makeProjectHttpBinding, DevCenterRole } from "./BindingHttp.ts";
import { ListEnvironmentDefinitionsByCatalog } from "./ListEnvironmentDefinitionsByCatalog.ts";

/**
 * Implementation of {@link ListEnvironmentDefinitionsByCatalog} over the
 * distilled `devcenter-data` data plane. Assigns the custom
 * `AzureDevCenterEnvironmentDefinitionReadRole` on the project.
 *
 * @layer
 * @provides Azure.DevCenter.ListEnvironmentDefinitionsByCatalog
 */
export const ListEnvironmentDefinitionsByCatalogHttp = Layer.effect(
  ListEnvironmentDefinitionsByCatalog,
  makeProjectHttpBinding({
    tag: "Azure.DevCenter.ListEnvironmentDefinitionsByCatalog",
    operation: devcenter.ListEnvironmentEnvironmentDefinitionsByCatalog,
    grants: [DevCenterRole.EnvironmentDefinitionRead],
  }),
);
