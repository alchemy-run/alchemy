import type * as chat from "@distilled.cloud/azure/communication-chat";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ChatRequest } from "./ChatTypes.ts";
import type { CommunicationService } from "./CommunicationService.ts";

export type CreateChatThreadRequest = ChatRequest<chat.CreateChatChatThreadRequest>;

/**
 * Create a chat thread as the user whose access token is passed.
 *
 * Chat authorizes each call with a Communication Services user access token
 * (scope `chat`), passed as `userAccessToken`, not with Azure RBAC: the
 * binding assigns no role. Get a token with {@link IssueAccessToken} or
 * {@link CreateIdentity}.
 * Provide {@link CreateChatThreadHttp}.
 *
 * ### Calling CreateChatThread
 * **Example:** CreateChatThread from a Function
 * ```typescript
 * // init
 * const createChatThread = yield* Azure.Communication.CreateChatThread(acs);
 *
 * // runtime
 * const created = yield* createChatThread({ userAccessToken, topic: "Support" });
 * // created.chatThread?.id
 * ```
 *
 * @binding
 * @category Communication
 */
export interface CreateChatThread extends Binding.Service<
  CreateChatThread,
  "Azure.Communication.CreateChatThread",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: CreateChatThreadRequest,
    ) => Effect.Effect<chat.CreateChatThreadResult, chat.CreateChatChatThreadError, RuntimeContext>
  >
> {}

export const CreateChatThread = Binding.Service<CreateChatThread>(
  "Azure.Communication.CreateChatThread",
);
