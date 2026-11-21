import * as discord from "@distilled.cloud/discord/discord";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { botUserId, listBotGuilds, ownership, physicalName } from "./internal/Discord.ts";
import type { Providers } from "./Providers.ts";

export interface SoundboardSoundProps {
  /** Guild the sound belongs to. Changing it replaces the sound. */
  guildId: string;
  /**
   * Sound name, 2-32 characters.
   * @default a name generated from the app, stage and logical id
   */
  name?: string;
  /**
   * The sound, as a data URI (`data:audio/mpeg;base64,...` or
   * `data:audio/ogg;base64,...`), up to 512 KiB and 5.2 seconds. Changing it
   * replaces the sound.
   */
  sound: string;
  /** Playback volume from 0 to 1. @default 1 */
  volume?: number;
  /** Id of a custom emoji shown with the sound. */
  emojiId?: string;
  /** Unicode emoji shown with the sound. */
  emojiName?: string;
}

export interface SoundboardSoundAttributes {
  /** Sound id (a snowflake). */
  soundId: string;
  /** Guild id. */
  guildId: string;
  /** Sound name. */
  name: string;
  /** Playback volume. */
  volume: number;
}

/**
 * A sound on a Discord guild's soundboard.
 *
 * The bot needs `MANAGE_GUILD_EXPRESSIONS` (or `CREATE_GUILD_EXPRESSIONS`). A
 * sound belongs to the stack when the bot uploaded it. Name, volume and emoji
 * update in place; new audio replaces the sound. Play it in a voice channel
 * with the `SendSoundboardSound` binding.
 *
 * ### Uploading Sounds
 * **Example:** Airhorn
 * ```typescript
 * const fs = yield* FileSystem.FileSystem;
 * const mp3 = yield* fs.readFile("./assets/airhorn.mp3");
 * yield* Discord.SoundboardSound("Airhorn", {
 *   guildId,
 *   name: "airhorn",
 *   sound: `data:audio/mpeg;base64,${Buffer.from(mp3).toString("base64")}`,
 *   volume: 0.5,
 *   emojiName: "📯",
 * });
 * ```
 *
 * @resource
 * @product Expression
 */
export interface SoundboardSound extends Resource<
  "Discord.SoundboardSound",
  SoundboardSoundProps,
  SoundboardSoundAttributes,
  never,
  Providers
> {}

export const SoundboardSound = Resource<SoundboardSound>("Discord.SoundboardSound");

const toAttributes = (
  guildId: string,
  sound: discord.SoundboardSoundResponse,
): SoundboardSoundAttributes => ({
  soundId: sound.sound_id,
  guildId,
  name: sound.name,
  volume: sound.volume,
});

const nameFor = (id: string, instanceId: string, props: { name?: string }) =>
  props.name !== undefined
    ? Effect.succeed(props.name)
    : physicalName(id, { instanceId, maxLength: 32 });

const getSound = (guildId: string, soundId: string) =>
  discord
    .getGuildSoundboardSound({ guild_id: guildId, sound_id: soundId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const listSounds = (guildId: string) =>
  discord.listGuildSoundboardSounds({ guild_id: guildId }).pipe(Effect.map((p) => p.items));

export const SoundboardSoundProvider = () =>
  Provider.succeed(SoundboardSound, {
    stables: ["soundId", "guildId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || olds === undefined) return;
      if (news.guildId !== (output?.guildId ?? olds.guildId) || news.sound !== olds.sound) {
        return { action: "replace" } as const;
      }
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output }) {
      if (output !== undefined) {
        const sound = yield* getSound(output.guildId, output.soundId);
        return sound ? toAttributes(output.guildId, sound) : undefined;
      }
      if (olds?.guildId === undefined) return undefined;
      const name = yield* nameFor(id, instanceId, olds);
      const match = (yield* listSounds(olds.guildId)).find((s) => s.name === name);
      if (match === undefined) return undefined;
      return ownership(toAttributes(olds.guildId, match), match.user?.id === (yield* botUserId()));
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const name =
        news.name === undefined && output?.name !== undefined
          ? output.name
          : yield* nameFor(id, instanceId, news);
      const volume = news.volume ?? 1;
      const observed = output ? yield* getSound(news.guildId, output.soundId) : undefined;
      if (observed === undefined) {
        return toAttributes(
          news.guildId,
          yield* discord.createGuildSoundboardSound({
            guild_id: news.guildId,
            name,
            sound: news.sound,
            volume,
            emoji_id: news.emojiId,
            emoji_name: news.emojiName,
          }),
        );
      }
      if (
        observed.name === name &&
        observed.volume === volume &&
        (observed.emoji_id ?? undefined) === news.emojiId &&
        (observed.emoji_name ?? undefined) === news.emojiName
      ) {
        return toAttributes(news.guildId, observed);
      }
      return toAttributes(
        news.guildId,
        yield* discord.updateGuildSoundboardSound({
          guild_id: news.guildId,
          sound_id: observed.sound_id,
          name,
          volume,
          emoji_id: news.emojiId ?? null,
          emoji_name: news.emojiName ?? null,
        }),
      );
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* discord
        .deleteGuildSoundboardSound({ guild_id: output.guildId, sound_id: output.soundId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),

    list: Effect.fn(function* () {
      const botId = yield* botUserId();
      const guilds = yield* listBotGuilds();
      const rows = yield* Effect.forEach(
        guilds,
        (guild) =>
          listSounds(guild.id).pipe(
            Effect.map((sounds) =>
              sounds.filter((s) => s.user?.id === botId).map((s) => toAttributes(guild.id, s)),
            ),
            Effect.catchTag("NotFound", () => Effect.succeed([])),
          ),
        { concurrency: 4 },
      );
      return rows.flat();
    }),
  });
