import type * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface PlayCallMediaRequest extends Omit<
  callAutomation.CallMediaPlayRequest,
  "endpoint"
> {}

/**
 * Play audio (a file, text, or SSML) to participants in the call.
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
 * Provide {@link PlayCallMediaHttp}.
 *
 * ### Calling PlayCallMedia
 * **Example:** PlayCallMedia from a Function
 * ```typescript
 * // init
 * const playCallMedia = yield* Azure.Communication.PlayCallMedia(acs);
 *
 * // runtime
 * yield* playCallMedia({
 *   callConnectionId,
 *   playSources: [{ kind: "file", file: { uri: "https://example.com/hold-music.wav" } }],
 * });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface PlayCallMedia extends Binding.Service<
  PlayCallMedia,
  "Azure.Communication.PlayCallMedia",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: PlayCallMediaRequest,
    ) => Effect.Effect<
      callAutomation.CallMediaPlayResponse,
      callAutomation.CallMediaPlayError,
      RuntimeContext
    >
  >
> {}

export const PlayCallMedia = Binding.Service<PlayCallMedia>("Azure.Communication.PlayCallMedia");
