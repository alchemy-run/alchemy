import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface GetLivenessWithVerifySessionResultRequest extends Omit<
  face.LivenessSessionOperationsGetLivenessWithVerifySessionResultRequest,
  "endpoint"
> {}

/**
 * Get session result of detectLivenessWithVerify/singleModal call.
 *
 * Binding assigns a custom role (`AzureAILivenessVerifySessionsReadRole`,
 * one per stack) with exactly the data action
 * `Face/detectlivenesswithverify/singlemodal/sessions/read` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link GetLivenessWithVerifySessionResultHttp}.
 *
 * ### Calling GetLivenessWithVerifySessionResult
 * **Example:** GetLivenessWithVerifySessionResult from a Function
 * ```typescript
 * // init
 * const getLivenessWithVerifySessionResult = yield* Azure.CognitiveServices.GetLivenessWithVerifySessionResult(account);
 *
 * // runtime
 * const result = yield* getLivenessWithVerifySessionResult({ sessionId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GetLivenessWithVerifySessionResult extends Binding.Service<
  GetLivenessWithVerifySessionResult,
  "Azure.CognitiveServices.GetLivenessWithVerifySessionResult",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: GetLivenessWithVerifySessionResultRequest,
    ) => Effect.Effect<
      face.LivenessWithVerifySession,
      face.LivenessSessionOperationsGetLivenessWithVerifySessionResultError,
      RuntimeContext
    >
  >
> {}

export const GetLivenessWithVerifySessionResult =
  Binding.Service<GetLivenessWithVerifySessionResult>(
    "Azure.CognitiveServices.GetLivenessWithVerifySessionResult",
  );
