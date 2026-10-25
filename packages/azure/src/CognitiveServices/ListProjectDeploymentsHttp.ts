import * as projects from "@distilled.cloud/azure/ai-projects";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { ListProjectDeployments } from "./ListProjectDeployments.ts";

/**
 * Implementation of {@link ListProjectDeployments} over the distilled `ai-projects`
 * data plane. Assigns the custom `AzureAIProjectDeploymentsReadRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.ListProjectDeployments
 */
export const ListProjectDeploymentsHttp = Layer.effect(
  ListProjectDeployments,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.ListProjectDeployments",
    operation: projects.ListDeployments,
    grant: AIRole.ProjectDeploymentsRead,
  }),
);
