import type * as chat from "@distilled.cloud/azure/communication-chat";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ChatRequest } from "./ChatTypes.ts";
import type { CommunicationService } from "./CommunicationService.ts";

export type ListChatParticipantsRequest = ChatRequest<chat.ListChatThreadChatParticipantsRequest>;

/**
 * List the participants of a chat thread, one page per call.
 *
 * Chat authorizes each call with a Communication Services user access token
 * (scope `chat`), passed as `userAccessToken`, not with Azure RBAC: the
 * binding assigns no role. Get a token with {@link IssueAccessToken} or
 * {@link CreateIdentity}.
 * Provide {@link ListChatParticipantsHttp}.
 *
 * ### Calling ListChatParticipants
 * **Example:** ListChatParticipants from a Function
 * ```typescript
 * // init
 * const listChatParticipants = yield* Azure.Communication.ListChatParticipants(acs);
 *
 * // runtime
 * const page = yield* listChatParticipants({ userAccessToken, chatThreadId });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface ListChatParticipants extends Binding.Service<
  ListChatParticipants,
  "Azure.Communication.ListChatParticipants",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: ListChatParticipantsRequest,
    ) => Effect.Effect<
      chat.ChatParticipantsCollection,
      chat.ListChatThreadChatParticipantsError,
      RuntimeContext
    >
  >
> {}

export const ListChatParticipants = Binding.Service<ListChatParticipants>(
  "Azure.Communication.ListChatParticipants",
);
