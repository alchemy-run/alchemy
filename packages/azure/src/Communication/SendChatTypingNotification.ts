import type * as chat from "@distilled.cloud/azure/communication-chat";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ChatRequest } from "./ChatTypes.ts";
import type { CommunicationService } from "./CommunicationService.ts";

export type SendChatTypingNotificationRequest =
  ChatRequest<chat.SendChatThreadTypingNotificationRequest>;

/**
 * Tell the other participants of a chat thread that the user is typing.
 *
 * Chat authorizes each call with a Communication Services user access token
 * (scope `chat`), passed as `userAccessToken`, not with Azure RBAC: the
 * binding assigns no role. Get a token with {@link IssueAccessToken} or
 * {@link CreateIdentity}.
 * Provide {@link SendChatTypingNotificationHttp}.
 *
 * ### Calling SendChatTypingNotification
 * **Example:** SendChatTypingNotification from a Function
 * ```typescript
 * // init
 * const sendChatTypingNotification = yield* Azure.Communication.SendChatTypingNotification(acs);
 *
 * // runtime
 * yield* sendChatTypingNotification({ userAccessToken, chatThreadId });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface SendChatTypingNotification extends Binding.Service<
  SendChatTypingNotification,
  "Azure.Communication.SendChatTypingNotification",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: SendChatTypingNotificationRequest,
    ) => Effect.Effect<
      chat.SendChatThreadTypingNotificationResponse,
      chat.SendChatThreadTypingNotificationError,
      RuntimeContext
    >
  >
> {}

export const SendChatTypingNotification = Binding.Service<SendChatTypingNotification>(
  "Azure.Communication.SendChatTypingNotification",
);
