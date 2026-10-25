import * as projects from "@distilled.cloud/azure/ai-projects";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { DeleteProjectDataset } from "./DeleteProjectDataset.ts";

/**
 * Implementation of {@link DeleteProjectDataset} over the distilled `ai-projects`
 * data plane. Assigns the custom `AzureAIProjectAssetsDeleteRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.DeleteProjectDataset
 */
export const DeleteProjectDatasetHttp = Layer.effect(
  DeleteProjectDataset,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.DeleteProjectDataset",
    operation: projects.DeleteDatasetVersion,
    grant: AIRole.ProjectAssetsDelete,
  }),
);
