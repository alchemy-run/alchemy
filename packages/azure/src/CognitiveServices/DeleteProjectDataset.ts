import type * as projects from "@distilled.cloud/azure/ai-projects";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface DeleteProjectDatasetRequest extends Omit<
  projects.DeleteDatasetVersionRequest,
  "endpoint"
> {}

/**
 * Delete the specific version of the DatasetVersion. The service returns 204
 * No Content if the DatasetVersion was deleted successfully or if the
 * DatasetVersion does not exist.
 *
 * Binding assigns a custom role (`AzureAIProjectAssetsDeleteRole`, one per
 * stack) with exactly the data action `AIServices/assets/delete` (under
 * `Microsoft.CognitiveServices/accounts/`), on the Foundry project only. The
 * project's account must be an `AIServices` account with
 * `allowProjectManagement: true`. The built-in **Azure AI User** and
 * **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link DeleteProjectDatasetHttp}.
 *
 * ### Calling DeleteProjectDataset
 * **Example:** DeleteProjectDataset from a Function
 * ```typescript
 * // init
 * const deleteProjectDataset = yield* Azure.CognitiveServices.DeleteProjectDataset(project);
 *
 * // runtime
 * const result = yield* deleteProjectDataset({ name, version });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface DeleteProjectDataset extends Binding.Service<
  DeleteProjectDataset,
  "Azure.CognitiveServices.DeleteProjectDataset",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: DeleteProjectDatasetRequest,
    ) => Effect.Effect<
      projects.DeleteDatasetVersionResponse,
      projects.DeleteDatasetVersionError,
      RuntimeContext
    >
  >
> {}

export const DeleteProjectDataset = Binding.Service<DeleteProjectDataset>(
  "Azure.CognitiveServices.DeleteProjectDataset",
);
