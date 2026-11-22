import type * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface MoveCallParticipantsRequest extends Omit<
  callAutomation.MoveCallConnectionParticipantsRequest,
  "endpoint"
> {}

/**
 * Move participants from another call into this call.
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
 * Provide {@link MoveCallParticipantsHttp}.
 *
 * ### Calling MoveCallParticipants
 * **Example:** MoveCallParticipants from a Function
 * ```typescript
 * // init
 * const moveCallParticipants = yield* Azure.Communication.MoveCallParticipants(acs);
 *
 * // runtime
 * yield* moveCallParticipants({
 *   callConnectionId,
 *   fromCall: otherCallConnectionId,
 *   targetParticipants: [{ communicationUser: { id: userId } }],
 * });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface MoveCallParticipants extends Binding.Service<
  MoveCallParticipants,
  "Azure.Communication.MoveCallParticipants",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: MoveCallParticipantsRequest,
    ) => Effect.Effect<
      callAutomation.MoveParticipantsResponse,
      callAutomation.MoveCallConnectionParticipantsError,
      RuntimeContext
    >
  >
> {}

export const MoveCallParticipants = Binding.Service<MoveCallParticipants>(
  "Azure.Communication.MoveCallParticipants",
);
