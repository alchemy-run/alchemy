import type * as chat from "@distilled.cloud/azure/communication-chat";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ChatRequest } from "./ChatTypes.ts";
import type { CommunicationService } from "./CommunicationService.ts";

export type AddChatParticipantsRequest = ChatRequest<chat.AddChatThreadChatParticipantsRequest>;

/**
 * Add participants to a chat thread.
 *
 * Chat authorizes each call with a Communication Services user access token
 * (scope `chat`), passed as `userAccessToken`, not with Azure RBAC: the
 * binding assigns no role. Get a token with {@link IssueAccessToken} or
 * {@link CreateIdentity}.
 * Provide {@link AddChatParticipantsHttp}.
 *
 * ### Calling AddChatParticipants
 * **Example:** AddChatParticipants from a Function
 * ```typescript
 * // init
 * const addChatParticipants = yield* Azure.Communication.AddChatParticipants(acs);
 *
 * // runtime
 * yield* addChatParticipants({
 *   userAccessToken,
 *   chatThreadId,
 *   participants: [{ communicationIdentifier: { communicationUser: { id: otherUserId } } }],
 * });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface AddChatParticipants extends Binding.Service<
  AddChatParticipants,
  "Azure.Communication.AddChatParticipants",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: AddChatParticipantsRequest,
    ) => Effect.Effect<
      chat.AddChatParticipantsResult,
      chat.AddChatThreadChatParticipantsError,
      RuntimeContext
    >
  >
> {}

export const AddChatParticipants = Binding.Service<AddChatParticipants>(
  "Azure.Communication.AddChatParticipants",
);
