import * as projects from "@distilled.cloud/azure/ai-projects";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { DeleteProjectIndex } from "./DeleteProjectIndex.ts";

/**
 * Implementation of {@link DeleteProjectIndex} over the distilled `ai-projects`
 * data plane. Assigns the custom `AzureAIProjectAssetsDeleteRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.DeleteProjectIndex
 */
export const DeleteProjectIndexHttp = Layer.effect(
  DeleteProjectIndex,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.DeleteProjectIndex",
    operation: projects.DeleteIndexVersion,
    grant: AIRole.ProjectAssetsDelete,
  }),
);
