import type * as Conversations from "@distilled.cloud/slack/conversations";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";

export type OpenConversationRequest = Conversations.ConversationsOpenRequest;

/**
 * Open (or resume) a direct message or group DM (`conversations.open`), to post to with its `channel.id`. Workspace-wide: it binds to no resource.
 *
 * Calls run as the host's bot (see {@link BotToken}). Provide
 * `Slack.OpenConversationHttp` on the Worker or Function.
 *
 * Needs one of the bot scopes `channels:manage`, `groups:write`, `im:write`, `mpim:write`.
 *
 * ### Calling it at runtime
 * **Example:** Open (or resume) a direct message or group DM
 * ```typescript
 * const openDm = yield* Slack.OpenConversation();
 * const { channel } = yield* openDm({ users: "U0123456789" });
 * ```
 *
 * @binding
 * @product Channel
 */
export interface OpenConversation extends Binding.Service<
  OpenConversation,
  "Slack.OpenConversation",
  () => Effect.Effect<
    (
      request: OpenConversationRequest,
    ) => Effect.Effect<
      Conversations.ConversationsOpenResponse,
      Conversations.ConversationsOpenError,
      RuntimeContext
    >
  >
> {}

export const OpenConversation = Binding.Service<OpenConversation>("Slack.OpenConversation");
