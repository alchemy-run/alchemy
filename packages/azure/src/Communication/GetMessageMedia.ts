import type * as messages from "@distilled.cloud/azure/communication-messages";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface GetMessageMediaRequest extends Omit<
  messages.GetStreamOperationMediaRequest,
  "endpoint"
> {}

/**
 * Download the media a user sent in an Advanced Messaging message.
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
 * Provide {@link GetMessageMediaHttp}.
 *
 * ### Calling GetMessageMedia
 * **Example:** GetMessageMedia from a Function
 * ```typescript
 * // init
 * const getMessageMedia = yield* Azure.Communication.GetMessageMedia(acs);
 *
 * // runtime
 * const media = yield* getMessageMedia({ id: mediaId });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface GetMessageMedia extends Binding.Service<
  GetMessageMedia,
  "Azure.Communication.GetMessageMedia",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: GetMessageMediaRequest,
    ) => Effect.Effect<
      messages.GetStreamOperationMediaResponse,
      messages.GetStreamOperationMediaError,
      RuntimeContext
    >
  >
> {}

export const GetMessageMedia = Binding.Service<GetMessageMedia>(
  "Azure.Communication.GetMessageMedia",
);
