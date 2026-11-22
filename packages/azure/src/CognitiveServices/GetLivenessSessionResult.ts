import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface GetLivenessSessionResultRequest extends Omit<
  face.GetLivenessSessionOperationLivenessSessionResultRequest,
  "endpoint"
> {}

/**
 * Get session result of detectLiveness/singleModal call.
 *
 * Binding assigns a custom role (`AzureAILivenessSessionsReadRole`, one per
 * stack) with exactly the data action
 * `Face/detectliveness/singlemodal/sessions/read` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link GetLivenessSessionResultHttp}.
 *
 * ### Calling GetLivenessSessionResult
 * **Example:** GetLivenessSessionResult from a Function
 * ```typescript
 * // init
 * const getLivenessSessionResult = yield* Azure.CognitiveServices.GetLivenessSessionResult(account);
 *
 * // runtime
 * const result = yield* getLivenessSessionResult({ sessionId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GetLivenessSessionResult extends Binding.Service<
  GetLivenessSessionResult,
  "Azure.CognitiveServices.GetLivenessSessionResult",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: GetLivenessSessionResultRequest,
    ) => Effect.Effect<
      face.LivenessSession,
      face.GetLivenessSessionOperationLivenessSessionResultError,
      RuntimeContext
    >
  >
> {}

export const GetLivenessSessionResult = Binding.Service<GetLivenessSessionResult>(
  "Azure.CognitiveServices.GetLivenessSessionResult",
);
