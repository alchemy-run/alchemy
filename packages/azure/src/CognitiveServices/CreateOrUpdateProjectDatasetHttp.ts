import * as projects from "@distilled.cloud/azure/ai-projects";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { CreateOrUpdateProjectDataset } from "./CreateOrUpdateProjectDataset.ts";

/**
 * Implementation of {@link CreateOrUpdateProjectDataset} over the distilled `ai-projects`
 * data plane. Assigns the custom `AzureAIProjectAssetsWriteRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.CreateOrUpdateProjectDataset
 */
export const CreateOrUpdateProjectDatasetHttp = Layer.effect(
  CreateOrUpdateProjectDataset,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.CreateOrUpdateProjectDataset",
    operation: projects.DatasetsCreateOrUpdateVersion,
    grant: AIRole.ProjectAssetsWrite,
  }),
);
