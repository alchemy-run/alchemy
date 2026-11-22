import type * as chat from "@distilled.cloud/azure/communication-chat";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ChatRequest } from "./ChatTypes.ts";
import type { CommunicationService } from "./CommunicationService.ts";

export type SendChatMessageRequest = ChatRequest<chat.SendChatThreadChatMessageRequest>;

/**
 * Send a message to a chat thread.
 *
 * Chat authorizes each call with a Communication Services user access token
 * (scope `chat`), passed as `userAccessToken`, not with Azure RBAC: the
 * binding assigns no role. Get a token with {@link IssueAccessToken} or
 * {@link CreateIdentity}.
 * Provide {@link SendChatMessageHttp}.
 *
 * ### Calling SendChatMessage
 * **Example:** SendChatMessage from a Function
 * ```typescript
 * // init
 * const sendChatMessage = yield* Azure.Communication.SendChatMessage(acs);
 *
 * // runtime
 * const sent = yield* sendChatMessage({ userAccessToken, chatThreadId, content: "Hello" });
 * // sent.id
 * ```
 *
 * @binding
 * @category Communication
 */
export interface SendChatMessage extends Binding.Service<
  SendChatMessage,
  "Azure.Communication.SendChatMessage",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: SendChatMessageRequest,
    ) => Effect.Effect<
      chat.SendChatMessageResult,
      chat.SendChatThreadChatMessageError,
      RuntimeContext
    >
  >
> {}

export const SendChatMessage = Binding.Service<SendChatMessage>(
  "Azure.Communication.SendChatMessage",
);
