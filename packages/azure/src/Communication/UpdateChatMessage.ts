import type * as chat from "@distilled.cloud/azure/communication-chat";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ChatRequest } from "./ChatTypes.ts";
import type { CommunicationService } from "./CommunicationService.ts";

export type UpdateChatMessageRequest = ChatRequest<chat.UpdateChatThreadChatMessageRequest>;

/**
 * Edit a message of a chat thread.
 *
 * Chat authorizes each call with a Communication Services user access token
 * (scope `chat`), passed as `userAccessToken`, not with Azure RBAC: the
 * binding assigns no role. Get a token with {@link IssueAccessToken} or
 * {@link CreateIdentity}.
 * Provide {@link UpdateChatMessageHttp}.
 *
 * ### Calling UpdateChatMessage
 * **Example:** UpdateChatMessage from a Function
 * ```typescript
 * // init
 * const updateChatMessage = yield* Azure.Communication.UpdateChatMessage(acs);
 *
 * // runtime
 * yield* updateChatMessage({ userAccessToken, chatThreadId, chatMessageId, content: "Edited" });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface UpdateChatMessage extends Binding.Service<
  UpdateChatMessage,
  "Azure.Communication.UpdateChatMessage",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: UpdateChatMessageRequest,
    ) => Effect.Effect<
      chat.UpdateChatThreadChatMessageResponse,
      chat.UpdateChatThreadChatMessageError,
      RuntimeContext
    >
  >
> {}

export const UpdateChatMessage = Binding.Service<UpdateChatMessage>(
  "Azure.Communication.UpdateChatMessage",
);
