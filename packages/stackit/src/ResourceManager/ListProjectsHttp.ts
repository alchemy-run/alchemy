import * as resourceManager from "@distilled.cloud/stackit/resource_manager";
import * as Layer from "effect/Layer";
import { makeParentHttpBinding } from "./BindingHttp.ts";
import { ListProjects } from "./ListProjects.ts";

/**
 * HTTP implementation of {@link ListProjects}.
 *
 * @layer
 * @provides Stackit.ResourceManager.ListProjects
 */
export const ListProjectsHttp = Layer.effect(
  ListProjects,
  makeParentHttpBinding({
    tag: "Stackit.ResourceManager.ListProjects",
    access: { permissions: ["resource-manager.project.list"] },
    operation: resourceManager.listProjects,
  }),
);
