import * as projects from "@distilled.cloud/azure/ai-projects";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { GetProjectDataset } from "./GetProjectDataset.ts";

/**
 * Implementation of {@link GetProjectDataset} over the distilled `ai-projects`
 * data plane. Assigns the custom `AzureAIProjectAssetsReadRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetProjectDataset
 */
export const GetProjectDatasetHttp = Layer.effect(
  GetProjectDataset,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.GetProjectDataset",
    operation: projects.GetDatasetVersion,
    grant: AIRole.ProjectAssetsRead,
  }),
);
