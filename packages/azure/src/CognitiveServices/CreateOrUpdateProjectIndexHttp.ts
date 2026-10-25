import * as projects from "@distilled.cloud/azure/ai-projects";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { CreateOrUpdateProjectIndex } from "./CreateOrUpdateProjectIndex.ts";

/**
 * Implementation of {@link CreateOrUpdateProjectIndex} over the distilled `ai-projects`
 * data plane. Assigns the custom `AzureAIProjectAssetsWriteRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.CreateOrUpdateProjectIndex
 */
export const CreateOrUpdateProjectIndexHttp = Layer.effect(
  CreateOrUpdateProjectIndex,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.CreateOrUpdateProjectIndex",
    operation: projects.IndexesCreateOrUpdateVersion,
    grant: AIRole.ProjectAssetsWrite,
  }),
);
