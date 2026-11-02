import * as registry from "@distilled.cloud/stackit/registry";
import * as Layer from "effect/Layer";
import { makeLocationHttpBinding } from "./BindingHttp.ts";
import { ListProjects } from "./ListProjects.ts";

/**
 * HTTP implementation of {@link ListProjects}.
 *
 * @layer
 * @provides Stackit.ContainerRegistry.ListProjects
 */
export const ListProjectsHttp = Layer.effect(
  ListProjects,
  makeLocationHttpBinding({
    tag: "Stackit.ContainerRegistry.ListProjects",
    permissions: ["container-registry.project.list"],
    operation: registry.listArtifactories,
  }),
);
