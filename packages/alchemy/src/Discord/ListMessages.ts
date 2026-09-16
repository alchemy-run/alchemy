import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { DiscordApiError } from "./ApiError.ts";
import type { GatewayMessage } from "./Events.ts";

export interface ListMessagesRequest {
  readonly channel_id: string;
  /** Messages BEFORE this message id (walking history backwards). */
  readonly before?: string;
  /** Messages AFTER this message id (catching up forwards). */
  readonly after?: string;
  /** Messages AROUND this message id (context for one message). */
  readonly around?: string;
  /**
   * 1–100.
   * @default 50
   */
  readonly limit?: number;
}

/** Newest first, as Discord returns them. */
export type ListMessagesResponse = ReadonlyArray<GatewayMessage>;

/**
 * Read a channel or thread's messages (`GET /channels/{id}/messages`)
 * — how an agent walks the conversation a mention arrived in:
 * `around` the mention for context, `before` it for history.
 * **Example:** Example
 * ```typescript
 * const listMessages = yield* Discord.ListMessages();
 * const thread = yield* listMessages({
 *   channel_id: mention.channelId,
 *   before: mention.messageId,
 *   limit: 50,
 * });
 * ```
 *
 * @binding
 */
export interface ListMessages extends Binding.Service<
  ListMessages,
  "Discord.ListMessages",
  () => Effect.Effect<
    (
      request: ListMessagesRequest,
    ) => Effect.Effect<ListMessagesResponse, DiscordApiError>
  >
> {}

export const ListMessages = Binding.Service<ListMessages>(
  "Discord.ListMessages",
);
