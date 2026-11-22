import * as projects from "@distilled.cloud/azure/ai-projects";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { ListProjectDatasetVersions } from "./ListProjectDatasetVersions.ts";

/**
 * Implementation of {@link ListProjectDatasetVersions} over the distilled `ai-projects`
 * data plane. Assigns the custom `AzureAIProjectAssetsReadRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.ListProjectDatasetVersions
 */
export const ListProjectDatasetVersionsHttp = Layer.effect(
  ListProjectDatasetVersions,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.ListProjectDatasetVersions",
    operation: projects.ListDatasetVersions,
    grant: AIRole.ProjectAssetsRead,
  }),
);
