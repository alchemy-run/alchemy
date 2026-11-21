import * as discord from "@distilled.cloud/discord/discord";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { botUserId, listBotGuilds, ownership, physicalName, sameJson } from "./internal/Discord.ts";
import type { Providers } from "./Providers.ts";

export interface EmojiProps {
  /** Guild the emoji belongs to. Changing it replaces the emoji. */
  guildId: string;
  /**
   * Emoji name, 2-32 characters of letters, digits and underscores.
   * @default a name generated from the app, stage and logical id
   */
  name?: string;
  /**
   * The image, as a data URI (`data:image/png;base64,...`; PNG, JPEG, GIF or
   * WebP, up to 256 KiB). Discord can't change an emoji's image, so changing
   * it replaces the emoji.
   */
  image: string;
  /** Roles allowed to use the emoji. Empty or omitted means everyone. */
  roles?: string[];
}

export interface EmojiAttributes {
  /** Emoji id (a snowflake). */
  emojiId: string;
  /** Guild id. */
  guildId: string;
  /** Emoji name. */
  name: string;
  /** Whether the image is animated. */
  animated: boolean;
  /** Roles allowed to use the emoji. */
  roles: string[];
  /** `<:name:id>` (or `<a:name:id>`), the syntax that renders it in a message. */
  mention: string;
}

/**
 * A custom emoji in a Discord guild.
 *
 * The bot needs `MANAGE_GUILD_EXPRESSIONS` (or `CREATE_GUILD_EXPRESSIONS`).
 * An emoji belongs to the stack when the bot uploaded it (Discord records the
 * uploader). Renames and role changes update in place; a new image replaces
 * the emoji.
 *
 * ### Uploading Emoji
 * **Example:** Emoji from a file
 * ```typescript
 * const fs = yield* FileSystem.FileSystem;
 * const png = yield* fs.readFile("./assets/party.png");
 * yield* Discord.Emoji("Party", {
 *   guildId,
 *   name: "party",
 *   image: `data:image/png;base64,${Buffer.from(png).toString("base64")}`,
 * });
 * ```
 *
 * **Example:** Emoji only moderators can use
 * ```typescript
 * yield* Discord.Emoji("ModStamp", {
 *   guildId,
 *   name: "mod_stamp",
 *   image,
 *   roles: [moderator.roleId],
 * });
 * ```
 *
 * @resource
 * @product Expression
 */
export interface Emoji extends Resource<
  "Discord.Emoji",
  EmojiProps,
  EmojiAttributes,
  never,
  Providers
> {}

export const Emoji = Resource<Emoji>("Discord.Emoji");

const toAttributes = (guildId: string, emoji: discord.EmojiResponse): EmojiAttributes => ({
  emojiId: emoji.id,
  guildId,
  name: emoji.name,
  animated: emoji.animated,
  roles: emoji.roles.filter((r): r is string => typeof r === "string"),
  mention: `<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.id}>`,
});

/** Emoji names: letters, digits and underscores, 2-32 characters. */
export const emojiName = (id: string, instanceId: string, props: { name?: string }) =>
  props.name !== undefined
    ? Effect.succeed(props.name)
    : physicalName(id, {
        instanceId,
        maxLength: 32,
        delimiter: "_",
        charset: /[^A-Za-z0-9_]/g,
      });

const getEmoji = (guildId: string, emojiId: string) =>
  discord
    .getGuildEmoji({ guild_id: guildId, emoji_id: emojiId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

export const EmojiProvider = () =>
  Provider.succeed(Emoji, {
    stables: ["emojiId", "guildId", "animated"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || olds === undefined) return;
      if (news.guildId !== (output?.guildId ?? olds.guildId) || news.image !== olds.image) {
        return { action: "replace" } as const;
      }
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output }) {
      if (output !== undefined) {
        const emoji = yield* getEmoji(output.guildId, output.emojiId);
        return emoji ? toAttributes(output.guildId, emoji) : undefined;
      }
      if (olds?.guildId === undefined) return undefined;
      const name = yield* emojiName(id, instanceId, olds);
      const emojis = (yield* discord.listGuildEmojis({ guild_id: olds.guildId })) ?? [];
      const match = emojis.find((e) => e.name === name);
      if (match === undefined) return undefined;
      return ownership(toAttributes(olds.guildId, match), match.user?.id === (yield* botUserId()));
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const name =
        news.name === undefined && output?.name !== undefined
          ? output.name
          : yield* emojiName(id, instanceId, news);
      const roles = news.roles ?? [];
      const observed = output ? yield* getEmoji(news.guildId, output.emojiId) : undefined;
      if (observed === undefined) {
        const created = yield* discord.createGuildEmoji({
          guild_id: news.guildId,
          name,
          image: news.image,
          roles,
        });
        return toAttributes(news.guildId, created);
      }
      const current = toAttributes(news.guildId, observed);
      if (current.name === name && sameJson([...current.roles].sort(), [...roles].sort())) {
        return current;
      }
      const updated = yield* discord.updateGuildEmoji({
        guild_id: news.guildId,
        emoji_id: observed.id,
        name,
        roles,
      });
      return toAttributes(news.guildId, updated);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* discord
        .deleteGuildEmoji({ guild_id: output.guildId, emoji_id: output.emojiId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),

    list: Effect.fn(function* () {
      const botId = yield* botUserId();
      const guilds = yield* listBotGuilds();
      const rows = yield* Effect.forEach(
        guilds,
        (guild) =>
          discord.listGuildEmojis({ guild_id: guild.id }).pipe(
            Effect.map((emojis) =>
              (emojis ?? [])
                .filter((e) => e.user?.id === botId)
                .map((e) => toAttributes(guild.id, e)),
            ),
            Effect.catchTag("NotFound", () => Effect.succeed([])),
          ),
        { concurrency: 4 },
      );
      return rows.flat();
    }),
  });
