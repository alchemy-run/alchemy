import type * as chat from "@distilled.cloud/azure/communication-chat";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ChatRequest } from "./ChatTypes.ts";
import type { CommunicationService } from "./CommunicationService.ts";

export type RemoveChatParticipantRequest = ChatRequest<chat.RemoveChatThreadChatParticipantRequest>;

/**
 * Remove a participant from a chat thread.
 *
 * Chat authorizes each call with a Communication Services user access token
 * (scope `chat`), passed as `userAccessToken`, not with Azure RBAC: the
 * binding assigns no role. Get a token with {@link IssueAccessToken} or
 * {@link CreateIdentity}.
 * Provide {@link RemoveChatParticipantHttp}.
 *
 * ### Calling RemoveChatParticipant
 * **Example:** RemoveChatParticipant from a Function
 * ```typescript
 * // init
 * const removeChatParticipant = yield* Azure.Communication.RemoveChatParticipant(acs);
 *
 * // runtime
 * yield* removeChatParticipant({ userAccessToken, chatThreadId, communicationUser: { id: otherUserId } });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface RemoveChatParticipant extends Binding.Service<
  RemoveChatParticipant,
  "Azure.Communication.RemoveChatParticipant",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: RemoveChatParticipantRequest,
    ) => Effect.Effect<
      chat.RemoveChatThreadChatParticipantResponse,
      chat.RemoveChatThreadChatParticipantError,
      RuntimeContext
    >
  >
> {}

export const RemoveChatParticipant = Binding.Service<RemoveChatParticipant>(
  "Azure.Communication.RemoveChatParticipant",
);
