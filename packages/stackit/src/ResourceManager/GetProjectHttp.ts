import * as resourceManager from "@distilled.cloud/stackit/resource_manager";
import * as Layer from "effect/Layer";
import { makeProjectHttpBinding } from "./BindingHttp.ts";
import { GetProject } from "./GetProject.ts";

/**
 * HTTP implementation of {@link GetProject}.
 *
 * @layer
 * @provides Stackit.ResourceManager.GetProject
 */
export const GetProjectHttp = Layer.effect(
  GetProject,
  makeProjectHttpBinding({
    tag: "Stackit.ResourceManager.GetProject",
    access: { permissions: ["resource-manager.project.get"] },
    operation: resourceManager.getProject,
  }),
);
