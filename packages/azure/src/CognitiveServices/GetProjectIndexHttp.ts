import * as projects from "@distilled.cloud/azure/ai-projects";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { GetProjectIndex } from "./GetProjectIndex.ts";

/**
 * Implementation of {@link GetProjectIndex} over the distilled `ai-projects`
 * data plane. Assigns the custom `AzureAIProjectAssetsReadRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetProjectIndex
 */
export const GetProjectIndexHttp = Layer.effect(
  GetProjectIndex,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.GetProjectIndex",
    operation: projects.GetIndexVersion,
    grant: AIRole.ProjectAssetsRead,
  }),
);
