import type * as chat from "@distilled.cloud/azure/communication-chat";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ChatRequest } from "./ChatTypes.ts";
import type { CommunicationService } from "./CommunicationService.ts";

export type GetChatMessageRequest = ChatRequest<chat.GetChatThreadChatMessageRequest>;

/**
 * Read one message of a chat thread.
 *
 * Chat authorizes each call with a Communication Services user access token
 * (scope `chat`), passed as `userAccessToken`, not with Azure RBAC: the
 * binding assigns no role. Get a token with {@link IssueAccessToken} or
 * {@link CreateIdentity}.
 * Provide {@link GetChatMessageHttp}.
 *
 * ### Calling GetChatMessage
 * **Example:** GetChatMessage from a Function
 * ```typescript
 * // init
 * const getChatMessage = yield* Azure.Communication.GetChatMessage(acs);
 *
 * // runtime
 * const message = yield* getChatMessage({ userAccessToken, chatThreadId, chatMessageId });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface GetChatMessage extends Binding.Service<
  GetChatMessage,
  "Azure.Communication.GetChatMessage",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: GetChatMessageRequest,
    ) => Effect.Effect<chat.ChatMessage, chat.GetChatThreadChatMessageError, RuntimeContext>
  >
> {}

export const GetChatMessage = Binding.Service<GetChatMessage>("Azure.Communication.GetChatMessage");
