import type * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface UpdateCallTranscriptionRequest extends Omit<
  callAutomation.UpdateCallMediaTranscriptionRequest,
  "endpoint"
> {}

/**
 * Change the language or speech model of a running transcription.
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
 * Provide {@link UpdateCallTranscriptionHttp}.
 *
 * ### Calling UpdateCallTranscription
 * **Example:** UpdateCallTranscription from a Function
 * ```typescript
 * // init
 * const updateCallTranscription = yield* Azure.Communication.UpdateCallTranscription(acs);
 *
 * // runtime
 * yield* updateCallTranscription({ callConnectionId, locale: "fr-FR" });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface UpdateCallTranscription extends Binding.Service<
  UpdateCallTranscription,
  "Azure.Communication.UpdateCallTranscription",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: UpdateCallTranscriptionRequest,
    ) => Effect.Effect<
      callAutomation.UpdateCallMediaTranscriptionResponse,
      callAutomation.UpdateCallMediaTranscriptionError,
      RuntimeContext
    >
  >
> {}

export const UpdateCallTranscription = Binding.Service<UpdateCallTranscription>(
  "Azure.Communication.UpdateCallTranscription",
);
