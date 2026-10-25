import * as projects from "@distilled.cloud/azure/ai-projects";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { GetProjectConnectionWithCredentials } from "./GetProjectConnectionWithCredentials.ts";

/**
 * Implementation of {@link GetProjectConnectionWithCredentials} over the distilled `ai-projects`
 * data plane. Assigns the custom `AzureAIProjectConnectionSecretsRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetProjectConnectionWithCredentials
 */
export const GetProjectConnectionWithCredentialsHttp = Layer.effect(
  GetProjectConnectionWithCredentials,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.GetProjectConnectionWithCredentials",
    operation: projects.GetConnectionWithCredentials,
    grant: AIRole.ProjectConnectionSecrets,
  }),
);
