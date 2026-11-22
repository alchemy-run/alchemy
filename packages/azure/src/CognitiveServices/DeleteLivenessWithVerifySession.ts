import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface DeleteLivenessWithVerifySessionRequest extends Omit<
  face.LivenessSessionOperationsDeleteLivenessWithVerifySessionRequest,
  "endpoint"
> {}

/**
 * Delete all session related information for matching the specified session
 * id. Deleting a session deactivates the Session Auth Token by blocking
 * future API calls made with that Auth Token. While this can be used to
 * remove any access for that token, those requests will still count towards
 * overall resource rate limits.
 *
 * Binding assigns a custom role (`AzureAILivenessVerifySessionsDeleteRole`,
 * one per stack) with exactly the data action
 * `Face/detectlivenesswithverify/singlemodal/sessions/delete` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link DeleteLivenessWithVerifySessionHttp}.
 *
 * ### Calling DeleteLivenessWithVerifySession
 * **Example:** DeleteLivenessWithVerifySession from a Function
 * ```typescript
 * // init
 * const deleteLivenessWithVerifySession = yield* Azure.CognitiveServices.DeleteLivenessWithVerifySession(account);
 *
 * // runtime
 * const result = yield* deleteLivenessWithVerifySession({ sessionId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface DeleteLivenessWithVerifySession extends Binding.Service<
  DeleteLivenessWithVerifySession,
  "Azure.CognitiveServices.DeleteLivenessWithVerifySession",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: DeleteLivenessWithVerifySessionRequest,
    ) => Effect.Effect<
      face.LivenessSessionOperationsDeleteLivenessWithVerifySessionResponse,
      face.LivenessSessionOperationsDeleteLivenessWithVerifySessionError,
      RuntimeContext
    >
  >
> {}

export const DeleteLivenessWithVerifySession = Binding.Service<DeleteLivenessWithVerifySession>(
  "Azure.CognitiveServices.DeleteLivenessWithVerifySession",
);
