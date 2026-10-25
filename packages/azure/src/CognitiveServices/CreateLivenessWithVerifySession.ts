import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface CreateLivenessWithVerifySessionRequest extends Omit<
  face.LivenessSessionOperationsCreateLivenessWithVerifySessionRequest,
  "endpoint"
> {}

/**
 * Create a new liveness session with verify. Provide the verify image during
 * session creation. A session is best for client device scenarios where
 * developers want to authorize a client device to perform only a liveness
 * detection without granting full access to their resource.
 *
 * Binding assigns a custom role (`AzureAILivenessVerifySessionsCreateRole`,
 * one per stack) with exactly the data action
 * `Face/detectlivenesswithverify/singlemodal/sessions/action` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link CreateLivenessWithVerifySessionHttp}.
 *
 * ### Calling CreateLivenessWithVerifySession
 * **Example:** CreateLivenessWithVerifySession from a Function
 * ```typescript
 * // init
 * const createLivenessWithVerifySession = yield* Azure.CognitiveServices.CreateLivenessWithVerifySession(account);
 *
 * // runtime
 * const result = yield* createLivenessWithVerifySession();
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface CreateLivenessWithVerifySession extends Binding.Service<
  CreateLivenessWithVerifySession,
  "Azure.CognitiveServices.CreateLivenessWithVerifySession",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request?: CreateLivenessWithVerifySessionRequest,
    ) => Effect.Effect<
      face.LivenessWithVerifySession,
      face.LivenessSessionOperationsCreateLivenessWithVerifySessionError,
      RuntimeContext
    >
  >
> {}

export const CreateLivenessWithVerifySession = Binding.Service<CreateLivenessWithVerifySession>(
  "Azure.CognitiveServices.CreateLivenessWithVerifySession",
);
