import type * as projects from "@distilled.cloud/azure/ai-projects";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface ListProjectConnectionsRequest extends Omit<
  projects.ListConnectionsRequest,
  "endpoint"
> {}

/**
 * List all connections in the project, without populating connection
 * credentials.
 *
 * Binding assigns a custom role (`AzureAIProjectConnectionsReadRole`, one
 * per stack) with exactly the data action `AIServices/connections/read`
 * (under `Microsoft.CognitiveServices/accounts/`), on the Foundry project
 * only. The project's account must be an `AIServices` account with
 * `allowProjectManagement: true`. The built-in **Azure AI User** and
 * **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link ListProjectConnectionsHttp}.
 *
 * ### Calling ListProjectConnections
 * **Example:** ListProjectConnections from a Function
 * ```typescript
 * // init
 * const listProjectConnections = yield* Azure.CognitiveServices.ListProjectConnections(project);
 *
 * // runtime
 * const { value } = yield* listProjectConnections();
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface ListProjectConnections extends Binding.Service<
  ListProjectConnections,
  "Azure.CognitiveServices.ListProjectConnections",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request?: ListProjectConnectionsRequest,
    ) => Effect.Effect<projects.PagedConnection, projects.ListConnectionsError, RuntimeContext>
  >
> {}

export const ListProjectConnections = Binding.Service<ListProjectConnections>(
  "Azure.CognitiveServices.ListProjectConnections",
);
