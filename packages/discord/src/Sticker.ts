import * as discord from "@distilled.cloud/discord/discord";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { botUserId, listBotGuilds, ownership, physicalName } from "./internal/Discord.ts";
import type { Providers } from "./Providers.ts";

export interface StickerProps {
  /** Guild the sticker belongs to. Changing it replaces the sticker. */
  guildId: string;
  /**
   * Sticker name, 2-30 characters.
   * @default a name generated from the app, stage and logical id
   */
  name?: string;
  /** Name of a Unicode emoji that suggests the sticker (autocomplete). */
  tags: string;
  /** Description, 2-100 characters. */
  description?: string;
  /**
   * The sticker file, base64 encoded: PNG, APNG or GIF (320x320, up to
   * 512 KiB), or a Lottie JSON (partnered and verified guilds only).
   * Changing it replaces the sticker.
   */
  file: string;
  /**
   * Media type of {@link file}.
   * @default "image/png"
   */
  contentType?: "image/png" | "image/apng" | "image/gif" | "application/json";
}

export interface StickerAttributes {
  /** Sticker id (a snowflake). */
  stickerId: string;
  /** Guild id. */
  guildId: string;
  /** Sticker name. */
  name: string;
  /** Autocomplete emoji name. */
  tags: string;
  /** Description. */
  description: string | undefined;
}

/**
 * A custom sticker in a Discord guild.
 *
 * The bot needs `MANAGE_GUILD_EXPRESSIONS` (or `CREATE_GUILD_EXPRESSIONS`).
 * Guilds get 5 sticker slots, more with boosts. A sticker belongs to the
 * stack when the bot uploaded it. Name, tags and description update in place;
 * a new file replaces the sticker.
 *
 * ### Uploading Stickers
 * **Example:** Sticker from a PNG
 * ```typescript
 * const fs = yield* FileSystem.FileSystem;
 * const png = yield* fs.readFile("./assets/wave.png");
 * yield* Discord.Sticker("Wave", {
 *   guildId,
 *   name: "wave",
 *   tags: "wave",
 *   description: "Hello!",
 *   file: Buffer.from(png).toString("base64"),
 * });
 * ```
 *
 * @resource
 * @product Expression
 */
export interface Sticker extends Resource<
  "Discord.Sticker",
  StickerProps,
  StickerAttributes,
  never,
  Providers
> {}

export const Sticker = Resource<Sticker>("Discord.Sticker");

const toAttributes = (sticker: discord.GuildStickerResponse): StickerAttributes => ({
  stickerId: sticker.id,
  guildId: sticker.guild_id,
  name: sticker.name,
  tags: sticker.tags,
  description: sticker.description ?? undefined,
});

const nameFor = (id: string, instanceId: string, props: { name?: string }) =>
  props.name !== undefined
    ? Effect.succeed(props.name)
    : physicalName(id, { instanceId, maxLength: 30 });

const getSticker = (guildId: string, stickerId: string) =>
  discord
    .getGuildSticker({ guild_id: guildId, sticker_id: stickerId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const fileOf = (props: StickerProps) =>
  Effect.sync(() => {
    const type = props.contentType ?? "image/png";
    const bytes = Uint8Array.from(Buffer.from(props.file, "base64"));
    const ext = type === "application/json" ? "json" : type.split("/")[1];
    return new File([bytes], `sticker.${ext}`, { type });
  });

export const StickerProvider = () =>
  Provider.succeed(Sticker, {
    stables: ["stickerId", "guildId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || olds === undefined) return;
      if (
        news.guildId !== (output?.guildId ?? olds.guildId) ||
        news.file !== olds.file ||
        (news.contentType ?? "image/png") !== (olds.contentType ?? "image/png")
      ) {
        return { action: "replace" } as const;
      }
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output }) {
      if (output !== undefined) {
        const sticker = yield* getSticker(output.guildId, output.stickerId);
        return sticker ? toAttributes(sticker) : undefined;
      }
      if (olds?.guildId === undefined) return undefined;
      const name = yield* nameFor(id, instanceId, olds);
      const stickers = (yield* discord.listGuildStickers({ guild_id: olds.guildId })) ?? [];
      const match = stickers.find((s) => s.name === name);
      if (match === undefined) return undefined;
      return ownership(toAttributes(match), match.user?.id === (yield* botUserId()));
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const name =
        news.name === undefined && output?.name !== undefined
          ? output.name
          : yield* nameFor(id, instanceId, news);
      const observed = output ? yield* getSticker(news.guildId, output.stickerId) : undefined;
      if (observed === undefined) {
        return toAttributes(
          yield* discord.createGuildSticker({
            guild_id: news.guildId,
            name,
            tags: news.tags,
            description: news.description,
            file: yield* fileOf(news),
          }),
        );
      }
      if (
        observed.name === name &&
        observed.tags === news.tags &&
        (observed.description ?? undefined) === news.description
      ) {
        return toAttributes(observed);
      }
      return toAttributes(
        yield* discord.updateGuildSticker({
          guild_id: news.guildId,
          sticker_id: observed.id,
          name,
          tags: news.tags,
          description: news.description ?? null,
        }),
      );
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* discord
        .deleteGuildSticker({ guild_id: output.guildId, sticker_id: output.stickerId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),

    list: Effect.fn(function* () {
      const botId = yield* botUserId();
      const guilds = yield* listBotGuilds();
      const rows = yield* Effect.forEach(
        guilds,
        (guild) =>
          discord.listGuildStickers({ guild_id: guild.id }).pipe(
            Effect.map((stickers) =>
              (stickers ?? []).filter((s) => s.user?.id === botId).map(toAttributes),
            ),
            Effect.catchTag("NotFound", () => Effect.succeed([])),
          ),
        { concurrency: 4 },
      );
      return rows.flat();
    }),
  });
