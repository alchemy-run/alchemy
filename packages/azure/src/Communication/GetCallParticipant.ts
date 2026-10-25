import type * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface GetCallParticipantRequest extends Omit<
  callAutomation.GetCallConnectionParticipantRequest,
  "endpoint"
> {}

/**
 * Read one participant of the call by its raw ID.
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
 * Provide {@link GetCallParticipantHttp}.
 *
 * ### Calling GetCallParticipant
 * **Example:** GetCallParticipant from a Function
 * ```typescript
 * // init
 * const getCallParticipant = yield* Azure.Communication.GetCallParticipant(acs);
 *
 * // runtime
 * const participant = yield* getCallParticipant({ callConnectionId, participantRawId: userId });
 * // participant.isMuted
 * ```
 *
 * @binding
 * @category Communication
 */
export interface GetCallParticipant extends Binding.Service<
  GetCallParticipant,
  "Azure.Communication.GetCallParticipant",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: GetCallParticipantRequest,
    ) => Effect.Effect<
      callAutomation.CallParticipant,
      callAutomation.GetCallConnectionParticipantError,
      RuntimeContext
    >
  >
> {}

export const GetCallParticipant = Binding.Service<GetCallParticipant>(
  "Azure.Communication.GetCallParticipant",
);
