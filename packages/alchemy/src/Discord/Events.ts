/**
 * The typed Discord wire — the tagged event union
 * {@link consumeServerEvents} delivers, the parser that produces it
 * ({@link parseGatewayEvent}), and the ONE identity function
 * ({@link eventKey}) delivery code correlates runs with.
 *
 * Each event is ONE `AI.Event` class: the class is the payload type,
 * the static carries the runtime schema, and the template is the
 * event's canonical prose — so a charter can splice
 * `${Discord.Mentioned}` directly, or alias it under org
 * vocabulary (`AI.Event("Mention", Discord.Mentioned)`).
 * Parsing is TOTAL translation, no filtering — routing decisions
 * belong to the consumer (`Match.tag` in the process
 * implementation), never to the parser.
 */
import * as Option from "effect/Option";
import * as S from "effect/Schema";
import { Event } from "../AI/Event.ts";

export interface Author {
  /** The user's snowflake id. */
  readonly id: string;
  readonly username: string;
  readonly bot?: boolean;
}

export const Author: S.Schema<Author> = S.Struct({
  id: S.String,
  username: S.String,
  bot: S.optionalKey(S.Boolean),
});

/**
 * The bot was mentioned in a message — the front-desk stimulus. The
 * channel id doubles as the conversation identity: Discord threads
 * ARE channels, so `channelId` names the thread a reply belongs in.
 */
export class Mentioned extends Event("Mentioned", {
  serverId: S.NullOr(S.String),
  channelId: S.String,
  messageId: S.String,
  author: Author,
  content: S.String,
  timestamp: S.optionalKey(S.String),
})`
The bot was mentioned in a Discord message — the author, the message
text, and the channel (or thread; threads are channels) the
conversation lives in.` {}

/** Any other (non-bot-authored) message — ambient traffic. */
export class MessageCreated extends Event("MessageCreated", {
  serverId: S.NullOr(S.String),
  channelId: S.String,
  messageId: S.String,
  author: Author,
  content: S.String,
  timestamp: S.optionalKey(S.String),
})`
A message was posted in a channel the bot can read, without
mentioning it — ambient traffic.` {}

/** Every server event the typed wire delivers. */
export type ServerEvent = Mentioned | MessageCreated;

/**
 * The natural identity key of a server event — the conversation it
 * belongs to (`channelId`; threads are channels). Shared by routing
 * (`send(item, { key })`), the ledger (dedupe), and `steer`.
 */
export const eventKey = (event: ServerEvent): string => event.channelId;

// ─── the wire: one gateway-shaped dispatch → one typed event ────────

/**
 * The subset of Discord's message object the wire reads — both the
 * gateway's MESSAGE_CREATE payload and the REST
 * `GET /channels/{id}/messages` items have this shape.
 */
export interface GatewayMessage {
  readonly id: string;
  readonly channel_id: string;
  /** The server — Discord's wire calls servers "guilds". */
  readonly guild_id?: string;
  readonly content: string;
  readonly author: { id: string; username: string; bot?: boolean };
  readonly mentions?: ReadonlyArray<{ id: string }>;
  readonly timestamp?: string;
}

/**
 * One delivery from a {@link ServerEventSource} implementation — a
 * gateway-shaped envelope whether it came from a real gateway
 * websocket or was synthesized by polling. `botUserId` rides along so
 * the parser can classify mentions without its own credential lookup.
 */
export interface GatewayDispatch {
  /** Deterministic delivery id (ledger food). */
  readonly id: string;
  readonly botUserId: string;
  readonly name: "MESSAGE_CREATE";
  readonly payload: GatewayMessage;
}

/**
 * Parse one dispatch into its typed {@link ServerEvent}. `None` only
 * for the bot's OWN messages (an org must never converse with
 * itself) — everything else is delivered and routing is the
 * consumer's.
 */
export const parseGatewayEvent = (
  event: GatewayDispatch,
): Option.Option<ServerEvent> => {
  switch (event.name) {
    case "MESSAGE_CREATE": {
      const message = event.payload;
      if (message.author.id === event.botUserId) return Option.none();
      const base = {
        serverId: message.guild_id ?? null,
        channelId: message.channel_id,
        messageId: message.id,
        author: {
          id: message.author.id,
          username: message.author.username,
          ...(message.author.bot !== undefined
            ? { bot: message.author.bot }
            : {}),
        },
        content: message.content,
        ...(message.timestamp !== undefined
          ? { timestamp: message.timestamp }
          : {}),
      };
      const mentioned =
        (message.mentions ?? []).some((user) => user.id === event.botUserId) ||
        message.content.includes(`<@${event.botUserId}>`);
      return Option.some(
        mentioned
          ? ({ _tag: "Mentioned", ...base } satisfies Mentioned)
          : ({ _tag: "MessageCreated", ...base } satisfies MessageCreated),
      );
    }
  }
};
