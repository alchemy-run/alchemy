import type * as chat from "@distilled.cloud/azure/communication-chat";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ChatRequest } from "./ChatTypes.ts";
import type { CommunicationService } from "./CommunicationService.ts";

export type DeleteChatThreadRequest = ChatRequest<chat.DeleteChatChatThreadRequest>;

/**
 * Delete a chat thread.
 *
 * Chat authorizes each call with a Communication Services user access token
 * (scope `chat`), passed as `userAccessToken`, not with Azure RBAC: the
 * binding assigns no role. Get a token with {@link IssueAccessToken} or
 * {@link CreateIdentity}.
 * Provide {@link DeleteChatThreadHttp}.
 *
 * ### Calling DeleteChatThread
 * **Example:** DeleteChatThread from a Function
 * ```typescript
 * // init
 * const deleteChatThread = yield* Azure.Communication.DeleteChatThread(acs);
 *
 * // runtime
 * yield* deleteChatThread({ userAccessToken, chatThreadId });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface DeleteChatThread extends Binding.Service<
  DeleteChatThread,
  "Azure.Communication.DeleteChatThread",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: DeleteChatThreadRequest,
    ) => Effect.Effect<
      chat.DeleteChatChatThreadResponse,
      chat.DeleteChatChatThreadError,
      RuntimeContext
    >
  >
> {}

export const DeleteChatThread = Binding.Service<DeleteChatThread>(
  "Azure.Communication.DeleteChatThread",
);
