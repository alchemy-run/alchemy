import type * as projects from "@distilled.cloud/azure/ai-projects";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface ListProjectDeploymentsRequest extends Omit<
  projects.ListDeploymentsRequest,
  "endpoint"
> {}

/**
 * List all deployed models in the project.
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
 * {@link ListProjectDeploymentsHttp}.
 *
 * ### Calling ListProjectDeployments
 * **Example:** ListProjectDeployments from a Function
 * ```typescript
 * // init
 * const listProjectDeployments = yield* Azure.CognitiveServices.ListProjectDeployments(project);
 *
 * // runtime
 * const { value } = yield* listProjectDeployments();
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface ListProjectDeployments extends Binding.Service<
  ListProjectDeployments,
  "Azure.CognitiveServices.ListProjectDeployments",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request?: ListProjectDeploymentsRequest,
    ) => Effect.Effect<projects.PagedDeployment, projects.ListDeploymentsError, RuntimeContext>
  >
> {}

export const ListProjectDeployments = Binding.Service<ListProjectDeployments>(
  "Azure.CognitiveServices.ListProjectDeployments",
);
