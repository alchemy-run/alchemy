import type * as projects from "@distilled.cloud/azure/ai-projects";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface ListProjectDatasetVersionsRequest extends Omit<
  projects.ListDatasetVersionsRequest,
  "endpoint"
> {}

/**
 * List all versions of the given DatasetVersion.
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
 * {@link ListProjectDatasetVersionsHttp}.
 *
 * ### Calling ListProjectDatasetVersions
 * **Example:** ListProjectDatasetVersions from a Function
 * ```typescript
 * // init
 * const listProjectDatasetVersions = yield* Azure.CognitiveServices.ListProjectDatasetVersions(project);
 *
 * // runtime
 * const result = yield* listProjectDatasetVersions({ name });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface ListProjectDatasetVersions extends Binding.Service<
  ListProjectDatasetVersions,
  "Azure.CognitiveServices.ListProjectDatasetVersions",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: ListProjectDatasetVersionsRequest,
    ) => Effect.Effect<
      projects.PagedDatasetVersion,
      projects.ListDatasetVersionsError,
      RuntimeContext
    >
  >
> {}

export const ListProjectDatasetVersions = Binding.Service<ListProjectDatasetVersions>(
  "Azure.CognitiveServices.ListProjectDatasetVersions",
);
