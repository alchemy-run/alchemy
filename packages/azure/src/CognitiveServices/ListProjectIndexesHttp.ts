import * as projects from "@distilled.cloud/azure/ai-projects";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { ListProjectIndexes } from "./ListProjectIndexes.ts";

/**
 * Implementation of {@link ListProjectIndexes} over the distilled `ai-projects`
 * data plane. Assigns the custom `AzureAIProjectAssetsReadRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.ListProjectIndexes
 */
export const ListProjectIndexesHttp = Layer.effect(
  ListProjectIndexes,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.ListProjectIndexes",
    operation: projects.ListIndexLatest,
    grant: AIRole.ProjectAssetsRead,
  }),
);
