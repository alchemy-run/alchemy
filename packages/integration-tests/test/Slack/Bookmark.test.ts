import * as Slack from "@alchemy.run/slack";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Bookmarks from "@distilled.cloud/slack/bookmarks";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Slack.providers() });

const find = (channelId: string, bookmarkId: string) =>
  Bookmarks.listBookmarks({ channel_id: channelId }).pipe(
    Effect.map((r) => r.bookmarks.find((b) => b.id === bookmarkId)),
  );

const program = (title: string, link: string, channel = "Docs") =>
  Effect.gen(function* () {
    const docs = yield* Slack.Channel(channel, {});
    const bookmark = yield* Slack.Bookmark("Runbook", {
      channelId: docs.channelId,
      title,
      link,
      emoji: ":books:",
    });
    return { docs, bookmark };
  });

test.provider(
  "create, edit in place, move to another channel, remove on destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(program("Runbook", "https://alchemy.run"));
      expect(first.bookmark.bookmarkId).toMatch(/^Bk/);
      let observed = yield* find(first.docs.channelId, first.bookmark.bookmarkId);
      expect(observed?.title).toBe("Runbook");
      expect(observed?.link).toBe("https://alchemy.run");

      const edited = yield* stack.deploy(program("Runbook v2", "https://alchemy.run/docs"));
      expect(edited.bookmark.bookmarkId).toBe(first.bookmark.bookmarkId);
      observed = yield* find(first.docs.channelId, first.bookmark.bookmarkId);
      expect(observed?.title).toBe("Runbook v2");
      expect(observed?.link).toBe("https://alchemy.run/docs");

      const plan = yield* stack.plan(program("Runbook v2", "https://alchemy.run/docs"));
      expect(plan.resources.Runbook?.action).toEqual("noop");

      // A new channel replaces the bookmark.
      const moved = yield* stack.deploy(program("Runbook v2", "https://alchemy.run/docs", "Docs2"));
      expect(moved.bookmark.channelId).toBe(moved.docs.channelId);
      expect(yield* find(first.docs.channelId, first.bookmark.bookmarkId)).toBeUndefined();

      yield* stack.destroy();
    }),
  { tags: ["provider:slack", "provider:slack:bookmark", "live"], timeout: 120_000 },
);
