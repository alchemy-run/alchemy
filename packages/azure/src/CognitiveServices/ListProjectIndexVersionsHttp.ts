import * as projects from "@distilled.cloud/azure/ai-projects";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { ListProjectIndexVersions } from "./ListProjectIndexVersions.ts";

/**
 * Implementation of {@link ListProjectIndexVersions} over the distilled `ai-projects`
 * data plane. Assigns the custom `AzureAIProjectAssetsReadRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.ListProjectIndexVersions
 */
export const ListProjectIndexVersionsHttp = Layer.effect(
  ListProjectIndexVersions,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.ListProjectIndexVersions",
    operation: projects.ListIndexVersions,
    grant: AIRole.ProjectAssetsRead,
  }),
);
