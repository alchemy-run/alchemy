import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { DiscordApiError } from "./ApiError.ts";
import type { GatewayMessage } from "./Events.ts";

export interface CreateMessageRequest {
  readonly channel_id: string;
  readonly content: string;
  /** Reply to a specific message in the channel (renders as a quote). */
  readonly message_reference?: { readonly message_id: string };
}

export type CreateMessageResponse = GatewayMessage;

/**
 * Post a message to a channel or thread
 * (`POST /channels/{id}/messages`) — the physics behind a Reply tool:
 * answer in the thread the mention arrived in, optionally quoting it.
 * **Example:** Example
 * ```typescript
 * const createMessage = yield* Discord.CreateMessage();
 * yield* createMessage({
 *   channel_id: mention.channelId,
 *   content: "tracked as #7 — follow along there",
 *   message_reference: { message_id: mention.messageId },
 * });
 * ```
 *
 * @binding
 */
export interface CreateMessage extends Binding.Service<
  CreateMessage,
  "Discord.CreateMessage",
  () => Effect.Effect<
    (
      request: CreateMessageRequest,
    ) => Effect.Effect<CreateMessageResponse, DiscordApiError>
  >
> {}

export const CreateMessage = Binding.Service<CreateMessage>(
  "Discord.CreateMessage",
);
