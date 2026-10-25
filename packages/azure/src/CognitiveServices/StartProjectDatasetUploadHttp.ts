import * as projects from "@distilled.cloud/azure/ai-projects";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { StartProjectDatasetUpload } from "./StartProjectDatasetUpload.ts";

/**
 * Implementation of {@link StartProjectDatasetUpload} over the distilled `ai-projects`
 * data plane. Assigns the custom `AzureAIProjectAssetsWriteRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.StartProjectDatasetUpload
 */
export const StartProjectDatasetUploadHttp = Layer.effect(
  StartProjectDatasetUpload,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.StartProjectDatasetUpload",
    operation: projects.DatasetsStartPendingUploadVersion,
    grant: AIRole.ProjectAssetsWrite,
  }),
);
