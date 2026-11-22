import type * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface StopCallTranscriptionRequest extends Omit<
  callAutomation.StopCallMediaTranscriptionRequest,
  "endpoint"
> {}

/**
 * Stop transcribing the call.
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
 * Provide {@link StopCallTranscriptionHttp}.
 *
 * ### Calling StopCallTranscription
 * **Example:** StopCallTranscription from a Function
 * ```typescript
 * // init
 * const stopCallTranscription = yield* Azure.Communication.StopCallTranscription(acs);
 *
 * // runtime
 * yield* stopCallTranscription({ callConnectionId });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface StopCallTranscription extends Binding.Service<
  StopCallTranscription,
  "Azure.Communication.StopCallTranscription",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: StopCallTranscriptionRequest,
    ) => Effect.Effect<
      callAutomation.StopCallMediaTranscriptionResponse,
      callAutomation.StopCallMediaTranscriptionError,
      RuntimeContext
    >
  >
> {}

export const StopCallTranscription = Binding.Service<StopCallTranscription>(
  "Azure.Communication.StopCallTranscription",
);
