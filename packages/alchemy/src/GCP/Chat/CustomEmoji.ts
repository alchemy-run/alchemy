import * as chat from "@distilled.cloud/gcp/chat_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  defaultEmojiPayload,
  EMOJI_PREFIX,
  findOwnedCustomEmoji,
  getCustomEmoji,
  ignoreMissing,
  isAlchemyEmojiName,
  lastSegment,
  listOwnedCustomEmojis,
  toCustomEmojiName,
  toEmojiName,
  toEmojiNameFromId,
} from "./internal.ts";

export type CustomEmojiPayload = {
  /**
   * Base64-encoded image bytes. Must be a square PNG, JPEG, or GIF
   * between 64 and 500 pixels, under 256 KB. Input-only.
   */
  fileContent?: string;
  /**
   * Image file name (`.png`, `.jpg`, or `.gif`). Input-only.
   */
  filename?: string;
};

export type CustomEmojiProps = {
  /**
   * Resource name `customEmojis/{customEmoji}` or an emoji-name alias
   * (`customEmojis/:alch-wave:`). Server-assigned on create. Immutable
   * — changing it replaces the emoji.
   */
  customEmojiId?: string;
  /**
   * Unique emoji name (`:alch-wave:`). Chat custom emojis have no labels
   * field, so Alchemy prefixes names with `alch-` for `list` / nuke.
   * Immutable — changing it replaces the emoji.
   */
  emojiName?: string;
  /**
   * Image payload. Required on create; ignored on update (the API has
   * no update method).
   */
  payload?: CustomEmojiPayload;
};

export type CustomEmoji = Resource<
  "GCP.Chat.CustomEmoji",
  CustomEmojiProps,
  {
    /** Full resource name `customEmojis/{customEmoji}`. */
    name: string;
    /** Custom emoji id (last path segment). */
    customEmojiId: string;
    /** Project id used when the emoji was reconciled. */
    project: string;
    /** Emoji name including colons. */
    emojiName: string | undefined;
    /** Unique key for the custom emoji. */
    uid: string | undefined;
    /** Temporary image URL, when returned. */
    temporaryImageUri: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Chat custom emoji.
 *
 * Custom emojis have no labels field, so Alchemy prefixes `emojiName`
 * with `alch-` (for example `:alch-wave:`) for `list` / nuke. The emoji
 * name is identity and immutable — changing it replaces the emoji.
 * Image payload is create-only. Requires a Workspace account with
 * custom emojis enabled.
 *
 * ### Creating a Custom Emoji
 * **Example:** Generated name with the default image
 * ```typescript
 * const emoji = yield* GCP.Chat.CustomEmoji("Wave", {});
 * ```
 *
 * **Example:** Explicit name and PNG payload
 * ```typescript
 * const emoji = yield* GCP.Chat.CustomEmoji("Wave", {
 *   emojiName: ":alch-wave:",
 *   payload: { filename: "wave.png", fileContent: pngBase64 },
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Chat
 */
export const CustomEmoji = Resource<CustomEmoji>("GCP.Chat.CustomEmoji");

export class CustomEmojiNotResolved extends Data.TaggedError(
  "GCP.Chat.CustomEmojiNotResolved",
)<{
  name: string;
}> {}

const toAttrs = (emoji: chat.CustomEmoji, project: string) => {
  const name = emoji.name ?? "";
  return {
    name,
    customEmojiId: lastSegment(name),
    project,
    emojiName: emoji.emojiName,
    uid: emoji.uid,
    temporaryImageUri: emoji.temporaryImageUri,
  };
};

const lookupName = (
  customEmojiId: string | undefined,
  emojiName: string | undefined,
  existingName: string | undefined,
) => {
  if (customEmojiId !== undefined && customEmojiId.length > 0) {
    return toCustomEmojiName(customEmojiId);
  }
  if (existingName !== undefined && existingName.length > 0) {
    return toCustomEmojiName(existingName);
  }
  if (emojiName !== undefined && emojiName.length > 0) {
    return toCustomEmojiName(toEmojiName(emojiName));
  }
  return "";
};

export const CustomEmojiProvider = () =>
  Provider.succeed(CustomEmoji, {
    stables: ["name", "customEmojiId", "project", "uid", "emojiName"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.customEmojiId ?? output?.customEmojiId;
      if (
        previousId !== undefined &&
        news.customEmojiId !== undefined &&
        toCustomEmojiName(news.customEmojiId) !==
          toCustomEmojiName(previousId) &&
        toCustomEmojiName(news.customEmojiId) !== output?.name
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousName = olds?.emojiName ?? output?.emojiName;
      if (
        previousName !== undefined &&
        news.emojiName !== undefined &&
        toEmojiName(news.emojiName) !== toEmojiName(previousName)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const emojiName = yield* toEmojiNameFromId(
        id,
        olds?.emojiName ?? output?.emojiName,
        output?.emojiName,
      );
      const name = lookupName(
        olds?.customEmojiId ?? output?.customEmojiId,
        emojiName,
        output?.name,
      );
      let existing = yield* getCustomEmoji(name);
      if (existing === undefined) {
        existing = yield* findOwnedCustomEmoji(emojiName);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return isAlchemyEmojiName(existing.emojiName) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const emojis = yield* listOwnedCustomEmojis();
        return emojis.map((emoji) => toAttrs(emoji, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const emojiName = yield* toEmojiNameFromId(
        id,
        news.emojiName,
        output?.emojiName,
      );
      const name = lookupName(
        news.customEmojiId ?? output?.customEmojiId,
        emojiName,
        output?.name,
      );

      let current = yield* getCustomEmoji(name);
      if (current === undefined) {
        current = yield* findOwnedCustomEmoji(emojiName);
      }

      if (current === undefined) {
        const payload = {
          fileContent:
            news.payload?.fileContent ?? defaultEmojiPayload().fileContent,
          filename: news.payload?.filename ?? defaultEmojiPayload().filename,
        };
        const created = yield* chat
          .createCustomEmojis({
            body: { emojiName, payload },
          })
          .pipe(
            Effect.catchTag("Conflict", () => findOwnedCustomEmoji(emojiName)),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new CustomEmojiNotResolved({
          name: name || `${EMOJI_PREFIX}${emojiName}`,
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const name =
        output.name ||
        (output.emojiName
          ? toCustomEmojiName(output.emojiName)
          : toCustomEmojiName(output.customEmojiId));
      if (name.length === 0) return;
      yield* ignoreMissing(chat.deleteCustomEmojis({ name }));
    }),
  });
