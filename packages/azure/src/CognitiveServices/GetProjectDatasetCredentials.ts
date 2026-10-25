import type * as projects from "@distilled.cloud/azure/ai-projects";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface GetProjectDatasetCredentialsRequest extends Omit<
  projects.GetDatasetCredentialsRequest,
  "endpoint"
> {}

/**
 * Get the SAS credential to access the storage account associated with a
 * Dataset version.
 *
 * Binding assigns a custom role (`AzureAIProjectAssetsWriteRole`, one per
 * stack) with exactly the data action `AIServices/assets/write` (under
 * `Microsoft.CognitiveServices/accounts/`), on the Foundry project only. The
 * project's account must be an `AIServices` account with
 * `allowProjectManagement: true`. The built-in **Azure AI User** and
 * **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link GetProjectDatasetCredentialsHttp}.
 *
 * ### Calling GetProjectDatasetCredentials
 * **Example:** GetProjectDatasetCredentials from a Function
 * ```typescript
 * // init
 * const getProjectDatasetCredentials = yield* Azure.CognitiveServices.GetProjectDatasetCredentials(project);
 *
 * // runtime
 * const result = yield* getProjectDatasetCredentials({ name, version });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GetProjectDatasetCredentials extends Binding.Service<
  GetProjectDatasetCredentials,
  "Azure.CognitiveServices.GetProjectDatasetCredentials",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: GetProjectDatasetCredentialsRequest,
    ) => Effect.Effect<
      projects.AssetCredentialResponse,
      projects.GetDatasetCredentialsError,
      RuntimeContext
    >
  >
> {}

export const GetProjectDatasetCredentials = Binding.Service<GetProjectDatasetCredentials>(
  "Azure.CognitiveServices.GetProjectDatasetCredentials",
);
