import type * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface UnholdCallParticipantRequest extends Omit<
  callAutomation.CallMediaUnholdRequest,
  "endpoint"
> {}

/**
 * Take a participant off hold.
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
 * Provide {@link UnholdCallParticipantHttp}.
 *
 * ### Calling UnholdCallParticipant
 * **Example:** UnholdCallParticipant from a Function
 * ```typescript
 * // init
 * const unholdCallParticipant = yield* Azure.Communication.UnholdCallParticipant(acs);
 *
 * // runtime
 * yield* unholdCallParticipant({
 *   callConnectionId,
 *   targetParticipant: { communicationUser: { id: userId } },
 * });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface UnholdCallParticipant extends Binding.Service<
  UnholdCallParticipant,
  "Azure.Communication.UnholdCallParticipant",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: UnholdCallParticipantRequest,
    ) => Effect.Effect<
      callAutomation.CallMediaUnholdResponse,
      callAutomation.CallMediaUnholdError,
      RuntimeContext
    >
  >
> {}

export const UnholdCallParticipant = Binding.Service<UnholdCallParticipant>(
  "Azure.Communication.UnholdCallParticipant",
);
