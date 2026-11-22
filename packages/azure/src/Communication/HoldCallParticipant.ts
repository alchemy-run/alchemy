import type * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface HoldCallParticipantRequest extends Omit<
  callAutomation.CallMediaHoldRequest,
  "endpoint"
> {}

/**
 * Put a participant on hold, optionally with hold music.
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
 * Provide {@link HoldCallParticipantHttp}.
 *
 * ### Calling HoldCallParticipant
 * **Example:** HoldCallParticipant from a Function
 * ```typescript
 * // init
 * const holdCallParticipant = yield* Azure.Communication.HoldCallParticipant(acs);
 *
 * // runtime
 * yield* holdCallParticipant({
 *   callConnectionId,
 *   targetParticipant: { communicationUser: { id: userId } },
 * });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface HoldCallParticipant extends Binding.Service<
  HoldCallParticipant,
  "Azure.Communication.HoldCallParticipant",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: HoldCallParticipantRequest,
    ) => Effect.Effect<
      callAutomation.CallMediaHoldResponse,
      callAutomation.CallMediaHoldError,
      RuntimeContext
    >
  >
> {}

export const HoldCallParticipant = Binding.Service<HoldCallParticipant>(
  "Azure.Communication.HoldCallParticipant",
);
