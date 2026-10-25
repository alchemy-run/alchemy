import type * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface TransferCallRequest extends Omit<
  callAutomation.TransferCallConnectionToParticipantRequest,
  "endpoint"
> {}

/**
 * Transfer a one-to-one call to another participant.
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
 * Provide {@link TransferCallHttp}.
 *
 * ### Calling TransferCall
 * **Example:** TransferCall from a Function
 * ```typescript
 * // init
 * const transferCall = yield* Azure.Communication.TransferCall(acs);
 *
 * // runtime
 * yield* transferCall({
 *   callConnectionId,
 *   targetParticipant: { phoneNumber: { value: "+14255550123" } },
 * });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface TransferCall extends Binding.Service<
  TransferCall,
  "Azure.Communication.TransferCall",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: TransferCallRequest,
    ) => Effect.Effect<
      callAutomation.TransferCallResponse,
      callAutomation.TransferCallConnectionToParticipantError,
      RuntimeContext
    >
  >
> {}

export const TransferCall = Binding.Service<TransferCall>("Azure.Communication.TransferCall");
