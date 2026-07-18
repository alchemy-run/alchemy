import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { DiscordApiError } from "./ApiError.ts";

/**
 * The channel object's principal fields.
 * @see {@link https://discord.com/developers/docs/resources/channel#channel-object | Channel object}
 */
export interface Channel {
  readonly id: string;
  /** 0 text, 5 announcement, 10/11/12 threads, … */
  readonly type: number;
  readonly name?: string | null;
  /** For threads: the channel the thread was started in. */
  readonly parent_id?: string | null;
  readonly guild_id?: string;
  readonly topic?: string | null;
}

export interface GetChannelRequest {
  readonly channel_id: string;
}

/**
 * Read one channel or thread (`GET /channels/{id}`) — orientation for
 * a conversation: is this a thread, what is it called, which channel
 * is its parent.
 * @binding
 * @example
 * ```typescript
 * const getChannel = yield* Discord.GetChannel();
 * const channel = yield* getChannel({ channel_id: mention.channelId });
 * ```
 */
export interface GetChannel extends Binding.Service<
  GetChannel,
  "Discord.GetChannel",
  () => Effect.Effect<
    (request: GetChannelRequest) => Effect.Effect<Channel, DiscordApiError>
  >
> {}

export const GetChannel = Binding.Service<GetChannel>("Discord.GetChannel");
