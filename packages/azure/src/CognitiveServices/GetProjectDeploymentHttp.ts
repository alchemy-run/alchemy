import * as projects from "@distilled.cloud/azure/ai-projects";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { GetProjectDeployment } from "./GetProjectDeployment.ts";

/**
 * Implementation of {@link GetProjectDeployment} over the distilled `ai-projects`
 * data plane. Assigns the custom `AzureAIProjectDeploymentsReadRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetProjectDeployment
 */
export const GetProjectDeploymentHttp = Layer.effect(
  GetProjectDeployment,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.GetProjectDeployment",
    operation: projects.GetDeployment,
    grant: AIRole.ProjectDeploymentsRead,
  }),
);
