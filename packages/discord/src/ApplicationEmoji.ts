import * as discord from "@distilled.cloud/discord/discord";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { applicationId, emojiName } from "./internal/Discord.ts";
import type { Providers } from "./Providers.ts";

export interface ApplicationEmojiProps {
  /**
   * Emoji name, 2-32 characters of letters, digits and underscores, unique
   * within the application.
   * @default a name generated from the app, stage and logical id
   */
  name?: string;
  /**
   * The image, as a data URI (PNG, JPEG, GIF or WebP, up to 256 KiB).
   * Changing it replaces the emoji.
   */
  image: string;
}

export interface ApplicationEmojiAttributes {
  /** Emoji id (a snowflake). */
  emojiId: string;
  /** Application that owns the emoji. */
  applicationId: string;
  /** Emoji name. */
  name: string;
  /** Whether the image is animated. */
  animated: boolean;
  /** `<:name:id>` (or `<a:name:id>`), the syntax that renders it in a message. */
  mention: string;
}

/**
 * An emoji owned by the application rather than a guild. The bot can use it
 * in any guild and DM, without `USE_EXTERNAL_EMOJIS`. An application holds up
 * to 2000.
 *
 * ### Uploading Application Emoji
 * **Example:** Status emoji for bot replies
 * ```typescript
 * const ok = yield* Discord.ApplicationEmoji("Ok", {
 *   name: "status_ok",
 *   image: okPngDataUri,
 * });
 * // later, in a message: `${ok.mention} deployed`
 * ```
 *
 * @resource
 * @product Application
 */
export interface ApplicationEmoji extends Resource<
  "Discord.ApplicationEmoji",
  ApplicationEmojiProps,
  ApplicationEmojiAttributes,
  never,
  Providers
> {}

export const ApplicationEmoji = Resource<ApplicationEmoji>("Discord.ApplicationEmoji");

const toAttributes = (appId: string, emoji: discord.EmojiResponse): ApplicationEmojiAttributes => ({
  emojiId: emoji.id,
  applicationId: appId,
  name: emoji.name,
  animated: emoji.animated,
  mention: `<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.id}>`,
});

const listEmojis = (appId: string) =>
  discord.listApplicationEmojis({ application_id: appId }).pipe(Effect.map((page) => page.items));

export const ApplicationEmojiProvider = () =>
  Provider.succeed(ApplicationEmoji, {
    stables: ["emojiId", "applicationId", "animated"],

    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news) || olds === undefined) return;
      if (news.image !== olds.image) return { action: "replace" } as const;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output }) {
      const appId = output?.applicationId ?? (yield* applicationId());
      const emojis = yield* listEmojis(appId);
      if (output !== undefined) {
        const emoji = emojis.find((e) => e.id === output.emojiId);
        return emoji ? toAttributes(appId, emoji) : undefined;
      }
      if (olds === undefined) return undefined;
      // Application emoji are the application's own, so a name match is ours.
      const name = yield* emojiName(id, instanceId, olds);
      const emoji = emojis.find((e) => e.name === name);
      return emoji ? toAttributes(appId, emoji) : undefined;
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const appId = yield* applicationId();
      const name =
        news.name === undefined && output?.name !== undefined
          ? output.name
          : yield* emojiName(id, instanceId, news);
      const observed = output
        ? yield* discord
            .getApplicationEmoji({ application_id: appId, emoji_id: output.emojiId })
            .pipe(Effect.catchTag("NotFound", () => Effect.undefined))
        : undefined;
      if (observed === undefined) {
        return toAttributes(
          appId,
          yield* discord.createApplicationEmoji({
            application_id: appId,
            name,
            image: news.image,
          }),
        );
      }
      if (observed.name === name) return toAttributes(appId, observed);
      return toAttributes(
        appId,
        yield* discord.updateApplicationEmoji({
          application_id: appId,
          emoji_id: observed.id,
          name,
        }),
      );
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* discord
        .deleteApplicationEmoji({ application_id: output.applicationId, emoji_id: output.emojiId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),

    list: Effect.fn(function* () {
      const appId = yield* applicationId();
      return (yield* listEmojis(appId)).map((e) => toAttributes(appId, e));
    }),
  });
