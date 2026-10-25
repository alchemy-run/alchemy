import type * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface CancelAddCallParticipantRequest extends Omit<
  callAutomation.CallConnectionCancelAddParticipantRequest,
  "endpoint"
> {}

/**
 * Cancel a pending `AddCallParticipant` invitation.
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
 * Provide {@link CancelAddCallParticipantHttp}.
 *
 * ### Calling CancelAddCallParticipant
 * **Example:** CancelAddCallParticipant from a Function
 * ```typescript
 * // init
 * const cancelAddCallParticipant = yield* Azure.Communication.CancelAddCallParticipant(acs);
 *
 * // runtime
 * yield* cancelAddCallParticipant({ callConnectionId, invitationId });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface CancelAddCallParticipant extends Binding.Service<
  CancelAddCallParticipant,
  "Azure.Communication.CancelAddCallParticipant",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: CancelAddCallParticipantRequest,
    ) => Effect.Effect<
      callAutomation.CancelAddParticipantResponse,
      callAutomation.CallConnectionCancelAddParticipantError,
      RuntimeContext
    >
  >
> {}

export const CancelAddCallParticipant = Binding.Service<CancelAddCallParticipant>(
  "Azure.Communication.CancelAddCallParticipant",
);
