import * as Slack from "@alchemy.run/slack";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Conversations from "@distilled.cloud/slack/conversations";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Slack.providers() });

const tags = ["provider:slack", "provider:slack:channel", "live"];

const info = (channelId: string) =>
  Conversations.conversationsInfo({ channel: channelId }).pipe(Effect.map((r) => r.channel));

test.provider(
  "create, update topic and purpose, rename, then archive on destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Slack.Channel("Alerts", { topic: "first topic", purpose: "first purpose" }),
      );
      expect(created.channelId).toMatch(/^C/);
      expect(created.isPrivate).toBe(false);
      let observed = yield* info(created.channelId);
      expect(observed.name).toBe(created.name);
      expect(observed.topic?.value).toBe("first topic");
      expect(observed.purpose?.value).toBe("first purpose");
      expect(observed.is_member).toBe(true);

      // A deterministic explicit name per user/worktree: renames in place.
      const name = `alchemy-${stack.stage}-alerts`.toLowerCase().replaceAll(/[^a-z0-9_-]/g, "-");
      const updated = yield* stack.deploy(
        Slack.Channel("Alerts", { name, topic: "second topic", purpose: "second purpose" }),
      );
      expect(updated.channelId).toBe(created.channelId);
      observed = yield* info(created.channelId);
      expect(observed.name).toBe(name);
      expect(observed.topic?.value).toBe("second topic");
      expect(observed.purpose?.value).toBe("second purpose");

      // Unchanged props plan no update.
      const plan = yield* stack.plan(
        Slack.Channel("Alerts", { name, topic: "second topic", purpose: "second purpose" }),
      );
      expect(plan.resources.Alerts?.action).toEqual("noop");

      yield* stack.destroy();
      observed = yield* info(created.channelId);
      expect(observed.is_archived).toBe(true);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a destroyed channel with a fixed name is unarchived on the next deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = `alchemy-${stack.stage}-reuse`.toLowerCase().replaceAll(/[^a-z0-9_-]/g, "-");

      const first = yield* stack.deploy(Slack.Channel("Reuse", { name }));
      yield* stack.destroy();
      expect((yield* info(first.channelId)).is_archived).toBe(true);

      const second = yield* stack.deploy(Slack.Channel("Reuse", { name }));
      expect(second.channelId).toBe(first.channelId);
      expect((yield* info(second.channelId)).is_archived).toBe(false);

      yield* stack.destroy();
      expect((yield* info(first.channelId)).is_archived).toBe(true);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "changing isPrivate replaces the channel",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const open = yield* stack.deploy(Slack.Channel("Secret", { isPrivate: false }));
      const closed = yield* stack.deploy(Slack.Channel("Secret", { isPrivate: true }));
      expect(closed.channelId).not.toBe(open.channelId);
      expect(closed.isPrivate).toBe(true);
      expect((yield* info(closed.channelId)).is_private).toBe(true);
      // The replaced public channel was archived.
      expect((yield* info(open.channelId)).is_archived).toBe(true);

      yield* stack.destroy();
      expect((yield* info(closed.channelId)).is_archived).toBe(true);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "lookup resolves a channel by name and by ID for another resource",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const channel = yield* stack.deploy(Slack.Channel("Lookup", {}));

      const program = Effect.gen(function* () {
        yield* Slack.Channel("Lookup", {});
        const byName = yield* Slack.Bookmark("ByName", {
          channelId: Slack.Channel.lookup({ name: channel.name }).channelId,
          title: "by name",
          link: "https://alchemy.run",
        });
        const byId = yield* Slack.Bookmark("ById", {
          channelId: Slack.Channel.lookup({ channelId: channel.channelId }).channelId,
          title: "by id",
          link: "https://alchemy.run/docs",
        });
        return { byName, byId };
      });
      const { byName, byId } = yield* stack.deploy(program);
      expect(byName.channelId).toBe(channel.channelId);
      expect(byId.channelId).toBe(channel.channelId);

      // A lookup re-resolves to the same channel.
      const plan = yield* stack.plan(program);
      expect(plan.resources.ByName?.action).toEqual("noop");

      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
