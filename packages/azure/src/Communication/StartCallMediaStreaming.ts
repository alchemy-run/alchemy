import type * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface StartCallMediaStreamingRequest extends Omit<
  callAutomation.StartCallMediaMediaStreamingRequest,
  "endpoint"
> {}

/**
 * Start streaming the call's audio to the WebSocket set in the call's
 * `mediaStreamingOptions`.
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
 * Provide {@link StartCallMediaStreamingHttp}.
 *
 * ### Calling StartCallMediaStreaming
 * **Example:** StartCallMediaStreaming from a Function
 * ```typescript
 * // init
 * const startCallMediaStreaming = yield* Azure.Communication.StartCallMediaStreaming(acs);
 *
 * // runtime
 * yield* startCallMediaStreaming({ callConnectionId });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface StartCallMediaStreaming extends Binding.Service<
  StartCallMediaStreaming,
  "Azure.Communication.StartCallMediaStreaming",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: StartCallMediaStreamingRequest,
    ) => Effect.Effect<
      callAutomation.StartCallMediaMediaStreamingResponse,
      callAutomation.StartCallMediaMediaStreamingError,
      RuntimeContext
    >
  >
> {}

export const StartCallMediaStreaming = Binding.Service<StartCallMediaStreaming>(
  "Azure.Communication.StartCallMediaStreaming",
);
