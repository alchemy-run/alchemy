import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface CreateLivenessSessionRequest extends Omit<
  face.CreateLivenessSessionOperationLivenessSessionRequest,
  "endpoint"
> {}

/**
 * Create a new detect liveness session. A session is best for client device
 * scenarios where developers want to authorize a client device to perform
 * only a liveness detection without granting full access to their resource.
 *
 * Binding assigns a custom role (`AzureAILivenessSessionsCreateRole`, one
 * per stack) with exactly the data action
 * `Face/detectliveness/singlemodal/sessions/action` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link CreateLivenessSessionHttp}.
 *
 * ### Calling CreateLivenessSession
 * **Example:** CreateLivenessSession from a Function
 * ```typescript
 * // init
 * const createLivenessSession = yield* Azure.CognitiveServices.CreateLivenessSession(account);
 *
 * // runtime
 * const result = yield* createLivenessSession({ livenessOperationMode });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface CreateLivenessSession extends Binding.Service<
  CreateLivenessSession,
  "Azure.CognitiveServices.CreateLivenessSession",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: CreateLivenessSessionRequest,
    ) => Effect.Effect<
      face.LivenessSession,
      face.CreateLivenessSessionOperationLivenessSessionError,
      RuntimeContext
    >
  >
> {}

export const CreateLivenessSession = Binding.Service<CreateLivenessSession>(
  "Azure.CognitiveServices.CreateLivenessSession",
);
