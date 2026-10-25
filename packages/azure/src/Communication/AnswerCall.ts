import type * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface AnswerCallRequest extends Omit<callAutomation.AnswerCallRequest, "endpoint"> {}

/**
 * Answer an incoming call with the `incomingCallContext` from its Event Grid
 * `IncomingCall` event.
 *
 * Binding assigns a custom role (`AzureCommunicationDataRole`, one per stack)
 * with exactly the actions `Microsoft.Communication/CommunicationServices/Read`
 * and `/Write`, on the communication service only. The Communication
 * Services data plane has no data actions and denies Entra callers without
 * both, reads included.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link AnswerCallHttp}.
 *
 * ### Calling AnswerCall
 * **Example:** AnswerCall from a Function
 * ```typescript
 * // init
 * const answerCall = yield* Azure.Communication.AnswerCall(acs);
 *
 * // runtime
 * const call = yield* answerCall({
 *   incomingCallContext: event.data.incomingCallContext,
 *   callbackUri: "https://example.com/call-events",
 * });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface AnswerCall extends Binding.Service<
  AnswerCall,
  "Azure.Communication.AnswerCall",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: AnswerCallRequest,
    ) => Effect.Effect<
      callAutomation.CallConnectionProperties,
      callAutomation.AnswerCallError,
      RuntimeContext
    >
  >
> {}

export const AnswerCall = Binding.Service<AnswerCall>("Azure.Communication.AnswerCall");
