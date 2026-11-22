import type * as projects from "@distilled.cloud/azure/ai-projects";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface GetProjectIndexRequest extends Omit<projects.GetIndexVersionRequest, "endpoint"> {}

/**
 * Get the specific version of the Index. The service returns 404 Not Found
 * error if the Index does not exist.
 *
 * Binding assigns a custom role (`AzureAIProjectAssetsReadRole`, one per
 * stack) with exactly the data action `AIServices/assets/read` (under
 * `Microsoft.CognitiveServices/accounts/`), on the Foundry project only. The
 * project's account must be an `AIServices` account with
 * `allowProjectManagement: true`. The built-in **Azure AI User** and
 * **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link GetProjectIndexHttp}.
 *
 * ### Calling GetProjectIndex
 * **Example:** GetProjectIndex from a Function
 * ```typescript
 * // init
 * const getProjectIndex = yield* Azure.CognitiveServices.GetProjectIndex(project);
 *
 * // runtime
 * const result = yield* getProjectIndex({ name, version });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GetProjectIndex extends Binding.Service<
  GetProjectIndex,
  "Azure.CognitiveServices.GetProjectIndex",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: GetProjectIndexRequest,
    ) => Effect.Effect<projects.Index, projects.GetIndexVersionError, RuntimeContext>
  >
> {}

export const GetProjectIndex = Binding.Service<GetProjectIndex>(
  "Azure.CognitiveServices.GetProjectIndex",
);
