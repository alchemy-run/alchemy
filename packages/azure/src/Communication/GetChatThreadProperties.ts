import type * as chat from "@distilled.cloud/azure/communication-chat";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ChatRequest } from "./ChatTypes.ts";
import type { CommunicationService } from "./CommunicationService.ts";

export type GetChatThreadPropertiesRequest =
  ChatRequest<chat.GetChatThreadChatThreadPropertiesRequest>;

/**
 * Read a chat thread's topic, creator, and metadata.
 *
 * Chat authorizes each call with a Communication Services user access token
 * (scope `chat`), passed as `userAccessToken`, not with Azure RBAC: the
 * binding assigns no role. Get a token with {@link IssueAccessToken} or
 * {@link CreateIdentity}.
 * Provide {@link GetChatThreadPropertiesHttp}.
 *
 * ### Calling GetChatThreadProperties
 * **Example:** GetChatThreadProperties from a Function
 * ```typescript
 * // init
 * const getChatThreadProperties = yield* Azure.Communication.GetChatThreadProperties(acs);
 *
 * // runtime
 * const thread = yield* getChatThreadProperties({ userAccessToken, chatThreadId });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface GetChatThreadProperties extends Binding.Service<
  GetChatThreadProperties,
  "Azure.Communication.GetChatThreadProperties",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: GetChatThreadPropertiesRequest,
    ) => Effect.Effect<
      chat.ChatThreadProperties,
      chat.GetChatThreadChatThreadPropertiesError,
      RuntimeContext
    >
  >
> {}

export const GetChatThreadProperties = Binding.Service<GetChatThreadProperties>(
  "Azure.Communication.GetChatThreadProperties",
);
