import type * as chat from "@distilled.cloud/azure/communication-chat";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ChatRequest } from "./ChatTypes.ts";
import type { CommunicationService } from "./CommunicationService.ts";

export type ListChatMessagesRequest = ChatRequest<chat.ListChatThreadChatMessagesRequest>;

/**
 * List the messages of a chat thread, newest first, one page per call.
 *
 * Chat authorizes each call with a Communication Services user access token
 * (scope `chat`), passed as `userAccessToken`, not with Azure RBAC: the
 * binding assigns no role. Get a token with {@link IssueAccessToken} or
 * {@link CreateIdentity}.
 * Provide {@link ListChatMessagesHttp}.
 *
 * ### Calling ListChatMessages
 * **Example:** ListChatMessages from a Function
 * ```typescript
 * // init
 * const listChatMessages = yield* Azure.Communication.ListChatMessages(acs);
 *
 * // runtime
 * const page = yield* listChatMessages({ userAccessToken, chatThreadId, maxPageSize: 50 });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface ListChatMessages extends Binding.Service<
  ListChatMessages,
  "Azure.Communication.ListChatMessages",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: ListChatMessagesRequest,
    ) => Effect.Effect<
      chat.ChatMessagesCollection,
      chat.ListChatThreadChatMessagesError,
      RuntimeContext
    >
  >
> {}

export const ListChatMessages = Binding.Service<ListChatMessages>(
  "Azure.Communication.ListChatMessages",
);
