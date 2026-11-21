import * as Bookmarks from "@distilled.cloud/slack/bookmarks";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type { Providers } from "./Providers.ts";

export interface BookmarkProps {
  /** Channel ID the bookmark sits in. Changing it replaces the bookmark. */
  channelId: string;
  /** Text shown on the bookmark. */
  title: string;
  /** URL the bookmark opens. */
  link: string;
  /** Emoji shown before the title, as `:name:`. */
  emoji?: string;
}

export interface BookmarkAttributes {
  /** Bookmark ID (`Bk…`). */
  bookmarkId: string;
  channelId: string;
  title: string;
  link: string;
  emoji: string;
}

export type Bookmark = Resource<
  "Slack.Bookmark",
  BookmarkProps,
  BookmarkAttributes,
  never,
  Providers
>;

/**
 * A link bookmarked in a channel's header bar.
 *
 * Needs the bot scopes `bookmarks:write` and `bookmarks:read`, and the bot
 * must be a member of the channel (a {@link Channel} the bot created always
 * is).
 *
 * ### Creating a Bookmark
 * **Example:** Link the runbook from the incidents channel
 * ```typescript
 * yield* Slack.Bookmark("Runbook", {
 *   channelId: incidents.channelId,
 *   title: "Runbook",
 *   link: "https://wiki.example.com/runbooks/incidents",
 *   emoji: ":books:",
 * });
 * ```
 *
 * @resource
 * @product Channel
 */
export const Bookmark = Resource<Bookmark>("Slack.Bookmark");

const toAttrs = (bookmark: Bookmarks.Bookmark): BookmarkAttributes => ({
  bookmarkId: bookmark.id,
  channelId: bookmark.channel_id ?? "",
  title: bookmark.title ?? "",
  link: bookmark.link ?? "",
  emoji: bookmark.emoji ?? "",
});

/** The bookmark, or `undefined` when it (or its channel) is gone. */
const find = (channelId: string, bookmarkId: string) =>
  Bookmarks.listBookmarks({ channel_id: channelId }).pipe(
    Effect.map((response) => response.bookmarks.find((b) => b.id === bookmarkId)),
    Effect.catchTag("ChannelNotFound", () => Effect.undefined),
  );

export const BookmarkProvider = () =>
  Provider.succeed(Bookmark, {
    stables: ["bookmarkId", "channelId"],

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      if (output !== undefined && news.channelId !== output.channelId) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      const bookmark = yield* find(output.channelId, output.bookmarkId);
      return bookmark === undefined ? undefined : toAttrs(bookmark);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      // Observe — bookmark IDs are server-assigned; the cached one is the
      // only handle.
      const observed =
        output !== undefined && output.channelId === news.channelId
          ? yield* find(output.channelId, output.bookmarkId)
          : undefined;

      // Ensure
      if (observed === undefined) {
        const created = yield* Bookmarks.addBookmark({
          channel_id: news.channelId,
          title: news.title,
          link: news.link,
          emoji: news.emoji,
          type: "link",
        });
        return toAttrs(created.bookmark);
      }

      // Sync
      if (
        observed.title !== news.title ||
        observed.link !== news.link ||
        (news.emoji !== undefined && (observed.emoji ?? "") !== news.emoji)
      ) {
        const edited = yield* Bookmarks.editBookmark({
          channel_id: news.channelId,
          bookmark_id: observed.id,
          title: news.title,
          link: news.link,
          emoji: news.emoji,
        });
        return toAttrs(edited.bookmark);
      }
      return toAttrs(observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* Bookmarks.removeBookmark({
        channel_id: output.channelId,
        bookmark_id: output.bookmarkId,
      }).pipe(Effect.catchTag(["NotFound", "ChannelNotFound"], () => Effect.void));
    }),
  });
