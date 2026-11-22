import type * as chat from "@distilled.cloud/azure/communication-chat";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ChatRequest } from "./ChatTypes.ts";
import type { CommunicationService } from "./CommunicationService.ts";

export type SendChatReadReceiptRequest = ChatRequest<chat.ChatThreadSendChatReadReceiptRequest>;

/**
 * Mark a chat message as read by the user whose access token is passed.
 *
 * Chat authorizes each call with a Communication Services user access token
 * (scope `chat`), passed as `userAccessToken`, not with Azure RBAC: the
 * binding assigns no role. Get a token with {@link IssueAccessToken} or
 * {@link CreateIdentity}.
 * Provide {@link SendChatReadReceiptHttp}.
 *
 * ### Calling SendChatReadReceipt
 * **Example:** SendChatReadReceipt from a Function
 * ```typescript
 * // init
 * const sendChatReadReceipt = yield* Azure.Communication.SendChatReadReceipt(acs);
 *
 * // runtime
 * yield* sendChatReadReceipt({ userAccessToken, chatThreadId, chatMessageId });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface SendChatReadReceipt extends Binding.Service<
  SendChatReadReceipt,
  "Azure.Communication.SendChatReadReceipt",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: SendChatReadReceiptRequest,
    ) => Effect.Effect<
      chat.ChatThreadSendChatReadReceiptResponse,
      chat.ChatThreadSendChatReadReceiptError,
      RuntimeContext
    >
  >
> {}

export const SendChatReadReceipt = Binding.Service<SendChatReadReceipt>(
  "Azure.Communication.SendChatReadReceipt",
);
