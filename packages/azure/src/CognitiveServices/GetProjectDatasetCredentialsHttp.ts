import * as projects from "@distilled.cloud/azure/ai-projects";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { GetProjectDatasetCredentials } from "./GetProjectDatasetCredentials.ts";

/**
 * Implementation of {@link GetProjectDatasetCredentials} over the distilled `ai-projects`
 * data plane. Assigns the custom `AzureAIProjectAssetsWriteRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetProjectDatasetCredentials
 */
export const GetProjectDatasetCredentialsHttp = Layer.effect(
  GetProjectDatasetCredentials,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.GetProjectDatasetCredentials",
    operation: projects.GetDatasetCredentials,
    grant: AIRole.ProjectAssetsWrite,
  }),
);
