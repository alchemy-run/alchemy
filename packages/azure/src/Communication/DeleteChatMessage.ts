import type * as chat from "@distilled.cloud/azure/communication-chat";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ChatRequest } from "./ChatTypes.ts";
import type { CommunicationService } from "./CommunicationService.ts";

export type DeleteChatMessageRequest = ChatRequest<chat.DeleteChatThreadChatMessageRequest>;

/**
 * Delete a message of a chat thread.
 *
 * Chat authorizes each call with a Communication Services user access token
 * (scope `chat`), passed as `userAccessToken`, not with Azure RBAC: the
 * binding assigns no role. Get a token with {@link IssueAccessToken} or
 * {@link CreateIdentity}.
 * Provide {@link DeleteChatMessageHttp}.
 *
 * ### Calling DeleteChatMessage
 * **Example:** DeleteChatMessage from a Function
 * ```typescript
 * // init
 * const deleteChatMessage = yield* Azure.Communication.DeleteChatMessage(acs);
 *
 * // runtime
 * yield* deleteChatMessage({ userAccessToken, chatThreadId, chatMessageId });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface DeleteChatMessage extends Binding.Service<
  DeleteChatMessage,
  "Azure.Communication.DeleteChatMessage",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: DeleteChatMessageRequest,
    ) => Effect.Effect<
      chat.DeleteChatThreadChatMessageResponse,
      chat.DeleteChatThreadChatMessageError,
      RuntimeContext
    >
  >
> {}

export const DeleteChatMessage = Binding.Service<DeleteChatMessage>(
  "Azure.Communication.DeleteChatMessage",
);
