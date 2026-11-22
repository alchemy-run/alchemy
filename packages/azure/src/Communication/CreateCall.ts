import type * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface CreateCallRequest extends Omit<callAutomation.CreateCallRequest, "endpoint"> {}

/**
 * Place an outbound call to phone numbers or Communication Services users.
 * Call events go to `callbackUri`.
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
 * Provide {@link CreateCallHttp}.
 *
 * ### Calling CreateCall
 * **Example:** CreateCall from a Function
 * ```typescript
 * // init
 * const createCall = yield* Azure.Communication.CreateCall(acs);
 *
 * // runtime
 * const call = yield* createCall({
 *   targets: [{ communicationUser: { id: userId } }],
 *   callbackUri: "https://example.com/call-events",
 * });
 * // call.callConnectionId
 * ```
 *
 * @binding
 * @category Communication
 */
export interface CreateCall extends Binding.Service<
  CreateCall,
  "Azure.Communication.CreateCall",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: CreateCallRequest,
    ) => Effect.Effect<
      callAutomation.CallConnectionProperties,
      callAutomation.CreateCallError,
      RuntimeContext
    >
  >
> {}

export const CreateCall = Binding.Service<CreateCall>("Azure.Communication.CreateCall");
