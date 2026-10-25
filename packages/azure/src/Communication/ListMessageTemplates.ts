import type * as messages from "@distilled.cloud/azure/communication-messages";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface ListMessageTemplatesRequest extends Omit<
  messages.ListTemplateOperationTemplatesRequest,
  "endpoint"
> {}

/**
 * List the message templates of an Advanced Messaging channel, one page per
 * call (pass the previous page's `nextLink` for the next).
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
 * Provide {@link ListMessageTemplatesHttp}.
 *
 * ### Calling ListMessageTemplates
 * **Example:** ListMessageTemplates from a Function
 * ```typescript
 * // init
 * const listMessageTemplates = yield* Azure.Communication.ListMessageTemplates(acs);
 *
 * // runtime
 * const page = yield* listMessageTemplates({ channelId: channelRegistrationId });
 * // page.value, page.nextLink
 * ```
 *
 * @binding
 * @category Communication
 */
export interface ListMessageTemplates extends Binding.Service<
  ListMessageTemplates,
  "Azure.Communication.ListMessageTemplates",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: ListMessageTemplatesRequest,
    ) => Effect.Effect<
      messages.PagedMessageTemplateItem,
      messages.ListTemplateOperationTemplatesError,
      RuntimeContext
    >
  >
> {}

export const ListMessageTemplates = Binding.Service<ListMessageTemplates>(
  "Azure.Communication.ListMessageTemplates",
);
