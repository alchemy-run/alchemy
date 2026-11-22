import type * as chat from "@distilled.cloud/azure/communication-chat";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ChatRequest } from "./ChatTypes.ts";
import type { CommunicationService } from "./CommunicationService.ts";

export type ListChatReadReceiptsRequest = ChatRequest<chat.ChatThreadListChatReadReceiptsRequest>;

/**
 * List the read receipts of a chat thread, one page per call.
 *
 * Chat authorizes each call with a Communication Services user access token
 * (scope `chat`), passed as `userAccessToken`, not with Azure RBAC: the
 * binding assigns no role. Get a token with {@link IssueAccessToken} or
 * {@link CreateIdentity}.
 * Provide {@link ListChatReadReceiptsHttp}.
 *
 * ### Calling ListChatReadReceipts
 * **Example:** ListChatReadReceipts from a Function
 * ```typescript
 * // init
 * const listChatReadReceipts = yield* Azure.Communication.ListChatReadReceipts(acs);
 *
 * // runtime
 * const page = yield* listChatReadReceipts({ userAccessToken, chatThreadId });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface ListChatReadReceipts extends Binding.Service<
  ListChatReadReceipts,
  "Azure.Communication.ListChatReadReceipts",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: ListChatReadReceiptsRequest,
    ) => Effect.Effect<
      chat.ChatMessageReadReceiptsCollection,
      chat.ChatThreadListChatReadReceiptsError,
      RuntimeContext
    >
  >
> {}

export const ListChatReadReceipts = Binding.Service<ListChatReadReceipts>(
  "Azure.Communication.ListChatReadReceipts",
);
