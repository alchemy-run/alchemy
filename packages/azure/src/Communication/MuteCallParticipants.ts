import type * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface MuteCallParticipantsRequest extends Omit<
  callAutomation.MuteCallConnectionRequest,
  "endpoint"
> {}

/**
 * Mute participants in the call.
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
 * Provide {@link MuteCallParticipantsHttp}.
 *
 * ### Calling MuteCallParticipants
 * **Example:** MuteCallParticipants from a Function
 * ```typescript
 * // init
 * const muteCallParticipants = yield* Azure.Communication.MuteCallParticipants(acs);
 *
 * // runtime
 * yield* muteCallParticipants({
 *   callConnectionId,
 *   targetParticipants: [{ communicationUser: { id: userId } }],
 * });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface MuteCallParticipants extends Binding.Service<
  MuteCallParticipants,
  "Azure.Communication.MuteCallParticipants",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: MuteCallParticipantsRequest,
    ) => Effect.Effect<
      callAutomation.MuteParticipantsResult,
      callAutomation.MuteCallConnectionError,
      RuntimeContext
    >
  >
> {}

export const MuteCallParticipants = Binding.Service<MuteCallParticipants>(
  "Azure.Communication.MuteCallParticipants",
);
