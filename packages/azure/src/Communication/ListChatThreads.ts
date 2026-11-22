import type * as chat from "@distilled.cloud/azure/communication-chat";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ChatRequest } from "./ChatTypes.ts";
import type { CommunicationService } from "./CommunicationService.ts";

export type ListChatThreadsRequest = ChatRequest<chat.ListChatChatThreadsRequest>;

/**
 * List the chat threads of the user whose access token is passed, one page
 * per call.
 *
 * Chat authorizes each call with a Communication Services user access token
 * (scope `chat`), passed as `userAccessToken`, not with Azure RBAC: the
 * binding assigns no role. Get a token with {@link IssueAccessToken} or
 * {@link CreateIdentity}.
 * Provide {@link ListChatThreadsHttp}.
 *
 * ### Calling ListChatThreads
 * **Example:** ListChatThreads from a Function
 * ```typescript
 * // init
 * const listChatThreads = yield* Azure.Communication.ListChatThreads(acs);
 *
 * // runtime
 * const page = yield* listChatThreads({ userAccessToken });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface ListChatThreads extends Binding.Service<
  ListChatThreads,
  "Azure.Communication.ListChatThreads",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: ListChatThreadsRequest,
    ) => Effect.Effect<
      chat.ChatThreadsItemCollection,
      chat.ListChatChatThreadsError,
      RuntimeContext
    >
  >
> {}

export const ListChatThreads = Binding.Service<ListChatThreads>(
  "Azure.Communication.ListChatThreads",
);
