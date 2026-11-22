import type * as projects from "@distilled.cloud/azure/ai-projects";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface GetProjectConnectionWithCredentialsRequest extends Omit<
  projects.GetConnectionWithCredentialsRequest,
  "endpoint"
> {}

/**
 * Get a connection by name, with its connection credentials.
 *
 * The credential's `key` (`ApiKey`) or `SAS` comes back `Redacted`; read
 * it with `Redacted.value` where you use it.
 *
 * Binding assigns a custom role (`AzureAIProjectConnectionSecretsRole`, one
 * per stack) with exactly the data action
 * `AIServices/connections/listSecrets/action` (under
 * `Microsoft.CognitiveServices/accounts/`), on the Foundry project only. The
 * project's account must be an `AIServices` account with
 * `allowProjectManagement: true`. The built-in **Azure AI User** and
 * **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link GetProjectConnectionWithCredentialsHttp}.
 *
 * ### Calling GetProjectConnectionWithCredentials
 * **Example:** GetProjectConnectionWithCredentials from a Function
 * ```typescript
 * // init
 * const getProjectConnectionWithCredentials = yield* Azure.CognitiveServices.GetProjectConnectionWithCredentials(project);
 *
 * // runtime
 * const result = yield* getProjectConnectionWithCredentials({ name });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GetProjectConnectionWithCredentials extends Binding.Service<
  GetProjectConnectionWithCredentials,
  "Azure.CognitiveServices.GetProjectConnectionWithCredentials",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: GetProjectConnectionWithCredentialsRequest,
    ) => Effect.Effect<
      projects.Connection,
      projects.GetConnectionWithCredentialsError,
      RuntimeContext
    >
  >
> {}

export const GetProjectConnectionWithCredentials =
  Binding.Service<GetProjectConnectionWithCredentials>(
    "Azure.CognitiveServices.GetProjectConnectionWithCredentials",
  );
