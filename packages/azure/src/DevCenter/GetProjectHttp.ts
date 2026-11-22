import * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Layer from "effect/Layer";
import { makeProjectHttpBinding, DevCenterRole } from "./BindingHttp.ts";
import { GetProject } from "./GetProject.ts";

/**
 * Implementation of {@link GetProject} over the distilled `devcenter-data`
 * data plane. Assigns the custom `AzureDevCenterProjectReadRole` on the
 * project.
 *
 * @layer
 * @provides Azure.DevCenter.GetProject
 */
export const GetProjectHttp = Layer.effect(
  GetProject,
  makeProjectHttpBinding({
    tag: "Azure.DevCenter.GetProject",
    operation: devcenter.GetDevCenterProject,
    grants: [DevCenterRole.ProjectRead],
  }),
);
