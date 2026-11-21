import * as Slack from "@alchemy.run/slack";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Conversations from "@distilled.cloud/slack/conversations";
import * as Effect from "effect/Effect";
import { aHuman } from "./helpers.ts";

const { test } = Test.make({ providers: Slack.providers() });

const members = (channelId: string) =>
  Conversations.conversationsMembers({ channel: channelId, limit: 200 }).pipe(
    Effect.map((r) => [...r.members]),
  );

test.provider(
  "invites a member on deploy and removes them on destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const user = yield* aHuman;

      const { channel } = yield* stack.deploy(
        Effect.gen(function* () {
          const channel = yield* Slack.Channel("Members", {});
          yield* Slack.ChannelMember("Member", { channelId: channel.channelId, userId: user });
          return { channel };
        }),
      );
      expect(yield* members(channel.channelId)).toContain(user);

      // Dropping the membership kicks the user; the channel stays.
      yield* stack.deploy(Slack.Channel("Members", {}));
      expect(yield* members(channel.channelId)).not.toContain(user);

      yield* stack.destroy();
    }),
  { tags: ["provider:slack", "provider:slack:channel-member", "live"], timeout: 120_000 },
);
