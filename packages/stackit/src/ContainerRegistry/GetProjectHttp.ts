import * as registry from "@distilled.cloud/stackit/registry";
import * as Layer from "effect/Layer";
import { makeProjectHttpBinding } from "./BindingHttp.ts";
import { GetProject } from "./GetProject.ts";

/**
 * HTTP implementation of {@link GetProject}.
 *
 * @layer
 * @provides Stackit.ContainerRegistry.GetProject
 */
export const GetProjectHttp = Layer.effect(
  GetProject,
  makeProjectHttpBinding({
    tag: "Stackit.ContainerRegistry.GetProject",
    permissions: ["container-registry.project.get"],
    operation: registry.getArtifactory,
  }),
);
