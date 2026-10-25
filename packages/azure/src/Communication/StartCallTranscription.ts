import type * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface StartCallTranscriptionRequest extends Omit<
  callAutomation.StartCallMediaTranscriptionRequest,
  "endpoint"
> {}

/**
 * Start transcribing the call to the WebSocket set in the call's
 * `transcriptionOptions`.
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
 * Provide {@link StartCallTranscriptionHttp}.
 *
 * ### Calling StartCallTranscription
 * **Example:** StartCallTranscription from a Function
 * ```typescript
 * // init
 * const startCallTranscription = yield* Azure.Communication.StartCallTranscription(acs);
 *
 * // runtime
 * yield* startCallTranscription({ callConnectionId, locale: "en-US" });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface StartCallTranscription extends Binding.Service<
  StartCallTranscription,
  "Azure.Communication.StartCallTranscription",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: StartCallTranscriptionRequest,
    ) => Effect.Effect<
      callAutomation.StartCallMediaTranscriptionResponse,
      callAutomation.StartCallMediaTranscriptionError,
      RuntimeContext
    >
  >
> {}

export const StartCallTranscription = Binding.Service<StartCallTranscription>(
  "Azure.Communication.StartCallTranscription",
);
