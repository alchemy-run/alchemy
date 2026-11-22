import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface DeleteLivenessSessionRequest extends Omit<
  face.DeleteLivenessSessionOperationLivenessSessionRequest,
  "endpoint"
> {}

/**
 * Delete all session related information for matching the specified session
 * id. Deleting a session deactivates the Session Auth Token by blocking
 * future API calls made with that Auth Token. While this can be used to
 * remove any access for that token, those requests will still count towards
 * overall resource rate limits.
 *
 * Binding assigns a custom role (`AzureAILivenessSessionsDeleteRole`, one
 * per stack) with exactly the data action
 * `Face/detectliveness/singlemodal/sessions/delete` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link DeleteLivenessSessionHttp}.
 *
 * ### Calling DeleteLivenessSession
 * **Example:** DeleteLivenessSession from a Function
 * ```typescript
 * // init
 * const deleteLivenessSession = yield* Azure.CognitiveServices.DeleteLivenessSession(account);
 *
 * // runtime
 * const result = yield* deleteLivenessSession({ sessionId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface DeleteLivenessSession extends Binding.Service<
  DeleteLivenessSession,
  "Azure.CognitiveServices.DeleteLivenessSession",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: DeleteLivenessSessionRequest,
    ) => Effect.Effect<
      face.DeleteLivenessSessionOperationLivenessSessionResponse,
      face.DeleteLivenessSessionOperationLivenessSessionError,
      RuntimeContext
    >
  >
> {}

export const DeleteLivenessSession = Binding.Service<DeleteLivenessSession>(
  "Azure.CognitiveServices.DeleteLivenessSession",
);
