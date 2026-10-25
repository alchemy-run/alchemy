import * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Layer from "effect/Layer";
import { makeProjectUserHttpBinding, DevCenterRole } from "./BindingHttp.ts";
import { ListEnvironments } from "./ListEnvironments.ts";

/**
 * Implementation of {@link ListEnvironments} over the distilled
 * `devcenter-data` data plane. Assigns the custom
 * `AzureDevCenterEnvironmentReadRole` on the project.
 *
 * @layer
 * @provides Azure.DevCenter.ListEnvironments
 */
export const ListEnvironmentsHttp = Layer.effect(
  ListEnvironments,
  makeProjectUserHttpBinding({
    tag: "Azure.DevCenter.ListEnvironments",
    operation: devcenter.ListEnvironmentEnvironmentsByUser,
    grants: [DevCenterRole.EnvironmentRead],
  }),
);
