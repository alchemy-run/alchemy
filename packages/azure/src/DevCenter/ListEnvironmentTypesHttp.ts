import * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Layer from "effect/Layer";
import { makeProjectHttpBinding, DevCenterRole } from "./BindingHttp.ts";
import { ListEnvironmentTypes } from "./ListEnvironmentTypes.ts";

/**
 * Implementation of {@link ListEnvironmentTypes} over the distilled
 * `devcenter-data` data plane. Assigns the custom
 * `AzureDevCenterEnvironmentTypeReadRole` on the project.
 *
 * @layer
 * @provides Azure.DevCenter.ListEnvironmentTypes
 */
export const ListEnvironmentTypesHttp = Layer.effect(
  ListEnvironmentTypes,
  makeProjectHttpBinding({
    tag: "Azure.DevCenter.ListEnvironmentTypes",
    operation: devcenter.ListEnvironmentEnvironmentTypes,
    grants: [DevCenterRole.EnvironmentTypeRead],
  }),
);
