import type * as projects from "@distilled.cloud/azure/ai-projects";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface CreateOrUpdateProjectIndexRequest extends Omit<
  projects.IndexesCreateOrUpdateVersionRequest,
  "endpoint"
> {}

/**
 * Create a new or update an existing Index with the given version id.
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
 * {@link CreateOrUpdateProjectIndexHttp}.
 *
 * ### Calling CreateOrUpdateProjectIndex
 * **Example:** CreateOrUpdateProjectIndex from a Function
 * ```typescript
 * // init
 * const createOrUpdateProjectIndex = yield* Azure.CognitiveServices.CreateOrUpdateProjectIndex(project);
 *
 * // runtime
 * const result = yield* createOrUpdateProjectIndex({ name, version, type });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface CreateOrUpdateProjectIndex extends Binding.Service<
  CreateOrUpdateProjectIndex,
  "Azure.CognitiveServices.CreateOrUpdateProjectIndex",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: CreateOrUpdateProjectIndexRequest,
    ) => Effect.Effect<projects.Index, projects.IndexesCreateOrUpdateVersionError, RuntimeContext>
  >
> {}

export const CreateOrUpdateProjectIndex = Binding.Service<CreateOrUpdateProjectIndex>(
  "Azure.CognitiveServices.CreateOrUpdateProjectIndex",
);
