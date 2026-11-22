import type * as projects from "@distilled.cloud/azure/ai-projects";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface CreateOrUpdateProjectDatasetRequest extends Omit<
  projects.DatasetsCreateOrUpdateVersionRequest,
  "endpoint"
> {}

/**
 * Create a new or update an existing DatasetVersion with the given version
 * id.
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
 * {@link CreateOrUpdateProjectDatasetHttp}.
 *
 * ### Calling CreateOrUpdateProjectDataset
 * **Example:** CreateOrUpdateProjectDataset from a Function
 * ```typescript
 * // init
 * const createOrUpdateProjectDataset = yield* Azure.CognitiveServices.CreateOrUpdateProjectDataset(project);
 *
 * // runtime
 * const result = yield* createOrUpdateProjectDataset({ name, version, dataUri, type });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface CreateOrUpdateProjectDataset extends Binding.Service<
  CreateOrUpdateProjectDataset,
  "Azure.CognitiveServices.CreateOrUpdateProjectDataset",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: CreateOrUpdateProjectDatasetRequest,
    ) => Effect.Effect<
      projects.DatasetVersion,
      projects.DatasetsCreateOrUpdateVersionError,
      RuntimeContext
    >
  >
> {}

export const CreateOrUpdateProjectDataset = Binding.Service<CreateOrUpdateProjectDataset>(
  "Azure.CognitiveServices.CreateOrUpdateProjectDataset",
);
