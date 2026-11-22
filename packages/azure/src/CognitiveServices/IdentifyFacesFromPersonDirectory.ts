import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface IdentifyFacesFromPersonDirectoryRequest extends Omit<
  face.FaceRecognitionOperationsIdentifyFromPersonDirectoryRequest,
  "endpoint"
> {}

/**
 * 1-to-many identification to find the closest matches of the specific query
 * person face from a person directory personIds array.
 *
 * Binding assigns a custom role (`AzureAIFaceIdentifyRole`, one per stack)
 * with exactly the data action `Face/identify/action` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link IdentifyFacesFromPersonDirectoryHttp}.
 *
 * ### Calling IdentifyFacesFromPersonDirectory
 * **Example:** IdentifyFacesFromPersonDirectory from a Function
 * ```typescript
 * // init
 * const identifyFacesFromPersonDirectory = yield* Azure.CognitiveServices.IdentifyFacesFromPersonDirectory(account);
 *
 * // runtime
 * const result = yield* identifyFacesFromPersonDirectory({ faceIds, personIds });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface IdentifyFacesFromPersonDirectory extends Binding.Service<
  IdentifyFacesFromPersonDirectory,
  "Azure.CognitiveServices.IdentifyFacesFromPersonDirectory",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: IdentifyFacesFromPersonDirectoryRequest,
    ) => Effect.Effect<
      face.FaceRecognitionOperationsIdentifyFromPersonDirectoryResponse,
      face.FaceRecognitionOperationsIdentifyFromPersonDirectoryError,
      RuntimeContext
    >
  >
> {}

export const IdentifyFacesFromPersonDirectory = Binding.Service<IdentifyFacesFromPersonDirectory>(
  "Azure.CognitiveServices.IdentifyFacesFromPersonDirectory",
);
