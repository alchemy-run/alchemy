/**
 * Discord EventSources for the organization.
 *
 * MOCK: `src/Discord` does not exist yet. This file sketches the shape a
 * future Discord provider package would export (mirroring
 * `src/GitHub/RepositoryEventSource.ts`): typed event families plus the
 * guild/channel refs that scope them. When src/Discord lands, these
 * constructors move there and this file becomes an import.
 */
import * as Context from "effect/Context";
import * as S from "effect/Schema";
import * as AI from "@/AI/index.ts";

/** A reference to the Discord guild whose events you want to receive. */
export interface GuildRef {
  guild: string;
}

/**
 * The channel tag for the Discord event family — subscribing to a Discord
 * source places this in the loop's `Req`; a harness Layer provides the
 * delivery physics (gateway connection or interactions webhook).
 */
export class DiscordEvents extends Context.Service<
  DiscordEvents,
  AI.EventChannelService
>()("org/DiscordEvents") {}

export const ThreadCreatedEvent = S.Struct({
  guild: S.String,
  channel: S.String,
  threadId: S.String,
  title: S.String,
  author: S.String,
});

export const MentionEvent = S.Struct({
  guild: S.String,
  channel: S.String,
  threadId: S.String,
  messageId: S.String,
  author: S.String,
  content: S.String,
});

export const ThreadCreated = (ref: GuildRef & { channel: string }) =>
  AI.EventSource(
    `discord.thread.created/${ref.guild}${ref.channel}`,
    ThreadCreatedEvent,
    DiscordEvents,
  );

export const Mention = (ref: GuildRef & { user: string }) =>
  AI.EventSource(
    `discord.mention/${ref.guild}@${ref.user}`,
    MentionEvent,
    DiscordEvents,
  );
