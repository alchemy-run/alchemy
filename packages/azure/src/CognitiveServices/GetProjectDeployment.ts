import type * as projects from "@distilled.cloud/azure/ai-projects";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface GetProjectDeploymentRequest extends Omit<
  projects.GetDeploymentRequest,
  "endpoint"
> {}

/**
 * Get a deployed model.
 *
 * Binding assigns a custom role (`AzureAIProjectDeploymentsReadRole`, one
 * per stack) with exactly the data action `AIServices/deployments/read`
 * (under `Microsoft.CognitiveServices/accounts/`), on the Foundry project
 * only. The project's account must be an `AIServices` account with
 * `allowProjectManagement: true`. The built-in **Azure AI User** and
 * **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link GetProjectDeploymentHttp}.
 *
 * ### Calling GetProjectDeployment
 * **Example:** GetProjectDeployment from a Function
 * ```typescript
 * // init
 * const getProjectDeployment = yield* Azure.CognitiveServices.GetProjectDeployment(project);
 *
 * // runtime
 * const deployment = yield* getProjectDeployment({ name: "gpt-4.1-mini" });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GetProjectDeployment extends Binding.Service<
  GetProjectDeployment,
  "Azure.CognitiveServices.GetProjectDeployment",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: GetProjectDeploymentRequest,
    ) => Effect.Effect<projects.Deployment, projects.GetDeploymentError, RuntimeContext>
  >
> {}

export const GetProjectDeployment = Binding.Service<GetProjectDeployment>(
  "Azure.CognitiveServices.GetProjectDeployment",
);
