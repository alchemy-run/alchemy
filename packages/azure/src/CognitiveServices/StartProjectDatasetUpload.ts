import type * as projects from "@distilled.cloud/azure/ai-projects";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface StartProjectDatasetUploadRequest extends Omit<
  projects.DatasetsStartPendingUploadVersionRequest,
  "endpoint"
> {}

/**
 * Start a new or get an existing pending upload of a dataset for a specific
 * version.
 *
 * The `blobReference.credential.sasUri` comes back `Redacted`; read it
 * with `Redacted.value` where you use it.
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
 * {@link StartProjectDatasetUploadHttp}.
 *
 * ### Calling StartProjectDatasetUpload
 * **Example:** StartProjectDatasetUpload from a Function
 * ```typescript
 * // init
 * const startProjectDatasetUpload = yield* Azure.CognitiveServices.StartProjectDatasetUpload(project);
 *
 * // runtime
 * const result = yield* startProjectDatasetUpload({ name, version, pendingUploadType });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface StartProjectDatasetUpload extends Binding.Service<
  StartProjectDatasetUpload,
  "Azure.CognitiveServices.StartProjectDatasetUpload",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: StartProjectDatasetUploadRequest,
    ) => Effect.Effect<
      projects.PendingUploadResponse,
      projects.DatasetsStartPendingUploadVersionError,
      RuntimeContext
    >
  >
> {}

export const StartProjectDatasetUpload = Binding.Service<StartProjectDatasetUpload>(
  "Azure.CognitiveServices.StartProjectDatasetUpload",
);
