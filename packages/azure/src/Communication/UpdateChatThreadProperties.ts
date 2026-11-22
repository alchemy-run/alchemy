import type * as chat from "@distilled.cloud/azure/communication-chat";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ChatRequest } from "./ChatTypes.ts";
import type { CommunicationService } from "./CommunicationService.ts";

export type UpdateChatThreadPropertiesRequest =
  ChatRequest<chat.UpdateChatThreadChatThreadPropertiesRequest>;

/**
 * Change a chat thread's topic, metadata, or retention policy.
 *
 * Chat authorizes each call with a Communication Services user access token
 * (scope `chat`), passed as `userAccessToken`, not with Azure RBAC: the
 * binding assigns no role. Get a token with {@link IssueAccessToken} or
 * {@link CreateIdentity}.
 * Provide {@link UpdateChatThreadPropertiesHttp}.
 *
 * ### Calling UpdateChatThreadProperties
 * **Example:** UpdateChatThreadProperties from a Function
 * ```typescript
 * // init
 * const updateChatThreadProperties = yield* Azure.Communication.UpdateChatThreadProperties(acs);
 *
 * // runtime
 * yield* updateChatThreadProperties({ userAccessToken, chatThreadId, topic: "Escalated" });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface UpdateChatThreadProperties extends Binding.Service<
  UpdateChatThreadProperties,
  "Azure.Communication.UpdateChatThreadProperties",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: UpdateChatThreadPropertiesRequest,
    ) => Effect.Effect<
      chat.UpdateChatThreadChatThreadPropertiesResponse,
      chat.UpdateChatThreadChatThreadPropertiesError,
      RuntimeContext
    >
  >
> {}

export const UpdateChatThreadProperties = Binding.Service<UpdateChatThreadProperties>(
  "Azure.Communication.UpdateChatThreadProperties",
);
