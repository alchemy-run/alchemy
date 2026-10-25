import type * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface AddCallParticipantRequest extends Omit<
  callAutomation.AddCallConnectionParticipantRequest,
  "endpoint"
> {}

/**
 * Invite a participant into the call.
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
 * Provide {@link AddCallParticipantHttp}.
 *
 * ### Calling AddCallParticipant
 * **Example:** AddCallParticipant from a Function
 * ```typescript
 * // init
 * const addCallParticipant = yield* Azure.Communication.AddCallParticipant(acs);
 *
 * // runtime
 * const added = yield* addCallParticipant({
 *   callConnectionId,
 *   participantToAdd: { communicationUser: { id: userId } },
 * });
 * // added.invitationId
 * ```
 *
 * @binding
 * @category Communication
 */
export interface AddCallParticipant extends Binding.Service<
  AddCallParticipant,
  "Azure.Communication.AddCallParticipant",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: AddCallParticipantRequest,
    ) => Effect.Effect<
      callAutomation.AddParticipantResponse,
      callAutomation.AddCallConnectionParticipantError,
      RuntimeContext
    >
  >
> {}

export const AddCallParticipant = Binding.Service<AddCallParticipant>(
  "Azure.Communication.AddCallParticipant",
);
