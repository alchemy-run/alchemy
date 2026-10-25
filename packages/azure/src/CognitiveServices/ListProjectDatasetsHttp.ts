import * as projects from "@distilled.cloud/azure/ai-projects";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { ListProjectDatasets } from "./ListProjectDatasets.ts";

/**
 * Implementation of {@link ListProjectDatasets} over the distilled `ai-projects`
 * data plane. Assigns the custom `AzureAIProjectAssetsReadRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.ListProjectDatasets
 */
export const ListProjectDatasetsHttp = Layer.effect(
  ListProjectDatasets,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.ListProjectDatasets",
    operation: projects.ListDatasetLatest,
    grant: AIRole.ProjectAssetsRead,
  }),
);
