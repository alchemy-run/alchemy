import type * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface RedirectCallRequest extends Omit<callAutomation.RedirectCallRequest, "endpoint"> {}

/**
 * Redirect an incoming call to another participant without answering it.
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
 * Provide {@link RedirectCallHttp}.
 *
 * ### Calling RedirectCall
 * **Example:** RedirectCall from a Function
 * ```typescript
 * // init
 * const redirectCall = yield* Azure.Communication.RedirectCall(acs);
 *
 * // runtime
 * yield* redirectCall({
 *   incomingCallContext: event.data.incomingCallContext,
 *   target: { phoneNumber: { value: "+14255550123" } },
 * });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface RedirectCall extends Binding.Service<
  RedirectCall,
  "Azure.Communication.RedirectCall",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: RedirectCallRequest,
    ) => Effect.Effect<
      callAutomation.RedirectCallResponse,
      callAutomation.RedirectCallError,
      RuntimeContext
    >
  >
> {}

export const RedirectCall = Binding.Service<RedirectCall>("Azure.Communication.RedirectCall");
