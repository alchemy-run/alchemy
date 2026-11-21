import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Slack from "@alchemy.run/slack";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Auth from "@distilled.cloud/slack/auth";
import * as Conversations from "@distilled.cloud/slack/conversations";
import * as Files from "@distilled.cloud/slack/files";
import * as Pins from "@distilled.cloud/slack/pins";
import * as Reactions from "@distilled.cloud/slack/reactions";
import * as Users from "@distilled.cloud/slack/users";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import SlackBindingsWorker, { BindingsChannel } from "./fixtures/bindings-worker.ts";
import { aHuman, slack } from "./helpers.ts";

const providers = Layer.mergeAll(Cloudflare.providers(), Slack.providers());
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers });

const tags = [
  "provider:cloudflare",
  "provider:cloudflare:worker",
  "provider:slack",
  "provider:slack:bindings",
  "live",
];

const Stack = Alchemy.Stack(
  "SlackBindingsStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const channel = yield* BindingsChannel;
    const worker = yield* SlackBindingsWorker;
    return { url: worker.url.as<string>(), channelId: channel.channelId };
  }),
);

const stack = beforeAll(deploy(Stack), { timeout: 300_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 300_000 });

type Answer = { data?: any; error?: { _tag: string } };

/** Call a binding inside the deployed Worker. */
const call = (binding: string, request: unknown = {}) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    const response = yield* Test.executeWhenReady(
      HttpClientRequest.post(`${url.replace(/\/+$/, "")}/${binding}`).pipe(
        HttpClientRequest.bodyJsonUnsafe(request),
      ),
    );
    expect(response.status).toBe(200);
    return (yield* response.json) as Answer;
  });

/** Call a binding that must succeed. */
const ok = (binding: string, request: unknown = {}) =>
  call(binding, request).pipe(
    Effect.map((answer) => {
      expect(answer.error).toBeUndefined();
      return answer.data;
    }),
  );

/** Call a binding that must fail with `tag`. */
const fails = (binding: string, request: unknown, tag: string) =>
  call(binding, request).pipe(Effect.map((answer) => expect(answer.error?._tag).toBe(tag)));

const history = (channelId: string) =>
  slack(Conversations.conversationsHistory({ channel: channelId, limit: 50 })).pipe(
    Effect.map((r) => r.messages as ReadonlyArray<{ ts: string; text?: string }>),
  );

describe.sequential("Slack bindings", () => {
  let ts = "";
  let human = "";

  describe("PostMessage", () => {
    test(
      "posts to the bound channel",
      Effect.gen(function* () {
        const { channelId } = yield* stack;
        const sent = yield* ok("PostMessage", { text: "hello from PostMessage" });
        ts = sent.ts;
        expect(sent.channel).toBe(channelId);
        const messages = yield* history(channelId);
        expect(messages.find((m) => m.ts === ts)?.text).toBe("hello from PostMessage");
      }),
      { tags, timeout: 180_000 },
    );
  });

  describe("UpdateMessage", () => {
    test(
      "edits the bot's message",
      Effect.gen(function* () {
        const { channelId } = yield* stack;
        yield* ok("UpdateMessage", { ts, text: "edited by UpdateMessage" });
        const messages = yield* history(channelId);
        expect(messages.find((m) => m.ts === ts)?.text).toBe("edited by UpdateMessage");
      }),
      { tags, timeout: 60_000 },
    );
  });

  describe("GetPermalink", () => {
    test(
      "links the message",
      Effect.gen(function* () {
        const { permalink } = yield* ok("GetPermalink", { message_ts: ts });
        expect(permalink).toMatch(/^https:\/\/.+\.slack\.com\/archives\//);
      }),
      { tags, timeout: 60_000 },
    );
  });

  describe("AddReaction", () => {
    test(
      "reacts to the message",
      Effect.gen(function* () {
        const { channelId } = yield* stack;
        yield* ok("AddReaction", { timestamp: ts, name: "white_check_mark" });
        const { message } = yield* slack(
          Reactions.getReaction({ channel: channelId, timestamp: ts }),
        );
        const reactions = (message as { reactions?: Array<{ name: string }> }).reactions ?? [];
        expect(reactions.map((r) => r.name)).toContain("white_check_mark");
      }),
      { tags, timeout: 60_000 },
    );
  });

  describe("GetReactions", () => {
    test(
      "reads the reactions",
      Effect.gen(function* () {
        const { message } = yield* ok("GetReactions", { timestamp: ts });
        expect(message.reactions.map((r: { name: string }) => r.name)).toContain(
          "white_check_mark",
        );
      }),
      { tags, timeout: 60_000 },
    );
  });

  describe("RemoveReaction", () => {
    test(
      "removes the reaction",
      Effect.gen(function* () {
        const { channelId } = yield* stack;
        yield* ok("RemoveReaction", { timestamp: ts, name: "white_check_mark" });
        const { message } = yield* slack(
          Reactions.getReaction({ channel: channelId, timestamp: ts }),
        );
        expect((message as { reactions?: unknown[] }).reactions ?? []).toHaveLength(0);
      }),
      { tags, timeout: 60_000 },
    );
  });

  describe("PinMessage", () => {
    test(
      "pins the message",
      Effect.gen(function* () {
        const { channelId } = yield* stack;
        yield* ok("PinMessage", { timestamp: ts });
        const { items } = yield* slack(Pins.listPins({ channel: channelId }));
        expect(JSON.stringify(items)).toContain(ts);
      }),
      { tags, timeout: 60_000 },
    );
  });

  describe("ListPins", () => {
    test(
      "lists the pin",
      Effect.gen(function* () {
        const { items } = yield* ok("ListPins");
        expect(JSON.stringify(items)).toContain(ts);
      }),
      { tags, timeout: 60_000 },
    );
  });

  describe("UnpinMessage", () => {
    test(
      "unpins the message",
      Effect.gen(function* () {
        const { channelId } = yield* stack;
        yield* ok("UnpinMessage", { timestamp: ts });
        const { items } = yield* slack(Pins.listPins({ channel: channelId }));
        expect(JSON.stringify(items ?? [])).not.toContain(ts);
      }),
      { tags, timeout: 60_000 },
    );
  });

  describe("GetReplies", () => {
    test(
      "reads a thread",
      Effect.gen(function* () {
        yield* ok("PostMessage", { text: "a reply", thread_ts: ts });
        const { messages } = yield* ok("GetReplies", { ts });
        expect(messages.map((m: { text: string }) => m.text)).toContain("a reply");
      }),
      { tags, timeout: 60_000 },
    );
  });

  describe("GetHistory", () => {
    test(
      "reads the channel history",
      Effect.gen(function* () {
        const { messages } = yield* ok("GetHistory", { limit: 20 });
        expect(messages.map((m: { ts: string }) => m.ts)).toContain(ts);
      }),
      { tags, timeout: 60_000 },
    );
  });

  describe("GetChannelInfo", () => {
    test(
      "reads the bound channel",
      Effect.gen(function* () {
        const { channelId } = yield* stack;
        const { channel } = yield* ok("GetChannelInfo");
        expect(channel.id).toBe(channelId);
      }),
      { tags, timeout: 60_000 },
    );
  });

  describe("ListChannelMembers", () => {
    test(
      "includes the bot",
      Effect.gen(function* () {
        const identity = yield* slack(Auth.testAuth({}));
        const { members } = yield* ok("ListChannelMembers");
        expect(members).toContain(identity.user_id);
      }),
      { tags, timeout: 60_000 },
    );
  });

  describe("SetChannelTopic", () => {
    test(
      "sets the topic",
      Effect.gen(function* () {
        const { channelId } = yield* stack;
        yield* ok("SetChannelTopic", { topic: "topic from the binding" });
        const { channel } = yield* slack(Conversations.conversationsInfo({ channel: channelId }));
        expect(channel.topic?.value).toBe("topic from the binding");
      }),
      { tags, timeout: 60_000 },
    );
  });

  describe("SetChannelPurpose", () => {
    test(
      "sets the description",
      Effect.gen(function* () {
        const { channelId } = yield* stack;
        yield* ok("SetChannelPurpose", { purpose: "purpose from the binding" });
        const { channel } = yield* slack(Conversations.conversationsInfo({ channel: channelId }));
        expect(channel.purpose?.value).toBe("purpose from the binding");
      }),
      { tags, timeout: 60_000 },
    );
  });

  describe("InviteToChannel", () => {
    test(
      "invites a member",
      Effect.gen(function* () {
        const { channelId } = yield* stack;
        human = yield* slack(aHuman);
        yield* ok("InviteToChannel", { users: human });
        const { members } = yield* slack(
          Conversations.conversationsMembers({ channel: channelId }),
        );
        expect(members).toContain(human);
      }),
      { tags, timeout: 60_000 },
    );
  });

  describe("PostEphemeral", () => {
    test(
      "posts a message only the member sees",
      Effect.gen(function* () {
        const { message_ts } = yield* ok("PostEphemeral", { user: human, text: "just for you" });
        expect(message_ts).toBeTruthy();
      }),
      { tags, timeout: 60_000 },
    );
  });

  describe("RemoveFromChannel", () => {
    test(
      "removes the member",
      Effect.gen(function* () {
        const { channelId } = yield* stack;
        yield* ok("RemoveFromChannel", { user: human });
        const { members } = yield* slack(
          Conversations.conversationsMembers({ channel: channelId }),
        );
        expect(members).not.toContain(human);
      }),
      { tags, timeout: 60_000 },
    );
  });

  describe("ScheduleMessage", () => {
    let scheduled = "";
    test(
      "schedules, lists and cancels a message",
      Effect.gen(function* () {
        const postAt = Math.floor(Date.now() / 1000) + 3600;
        const result = yield* ok("ScheduleMessage", { post_at: postAt, text: "later" });
        scheduled = result.scheduled_message_id;
        const listed = yield* ok("ListScheduledMessages");
        expect(listed.scheduled_messages.map((m: { id: string }) => m.id)).toContain(scheduled);
        yield* ok("DeleteScheduledMessage", { scheduled_message_id: scheduled });
        const after = yield* ok("ListScheduledMessages");
        expect(after.scheduled_messages.map((m: { id: string }) => m.id)).not.toContain(scheduled);
      }),
      { tags, timeout: 60_000 },
    );
  });

  describe("DeleteScheduledMessage", () => {
    test(
      "fails with a typed error for an unknown ID",
      fails(
        "DeleteScheduledMessage",
        { scheduled_message_id: "Q0000000000" },
        "InvalidScheduledMessageId",
      ),
      { tags, timeout: 60_000 },
    );
  });

  describe("ListScheduledMessages", () => {
    test(
      "lists nothing once every message is cancelled",
      Effect.gen(function* () {
        const { scheduled_messages } = yield* ok("ListScheduledMessages");
        expect(scheduled_messages).toHaveLength(0);
      }),
      { tags, timeout: 60_000 },
    );
  });

  describe("UploadFile", () => {
    test(
      "uploads and shares a file into the channel",
      Effect.gen(function* () {
        const { channelId } = yield* stack;
        const { files } = yield* ok("UploadFile", {
          filename: "report.csv",
          content: "date,signups\n2026-11-20,42\n",
          initialComment: "today's numbers",
        });
        const fileId = files[0].id as string;
        const { file } = yield* slack(Files.filesInfo({ file: fileId }));
        expect((file as { name?: string }).name).toBe("report.csv");
        expect(JSON.stringify(file)).toContain(channelId);
      }),
      { tags, timeout: 90_000 },
    );
  });

  describe("DeleteMessage", () => {
    test(
      "deletes the message",
      Effect.gen(function* () {
        const { channelId } = yield* stack;
        yield* ok("DeleteMessage", { ts });
        const messages = yield* history(channelId);
        expect(messages.find((m) => m.ts === ts)).toBeUndefined();
      }),
      { tags, timeout: 60_000 },
    );
  });

  describe("GetUser", () => {
    test(
      "reads a member",
      Effect.gen(function* () {
        const { user } = yield* ok("GetUser", { user: human });
        expect(user.id).toBe(human);
      }),
      { tags, timeout: 60_000 },
    );
  });

  describe("LookupUserByEmail", () => {
    test(
      "finds the member by email",
      Effect.gen(function* () {
        const { user } = yield* slack(Users.usersInfo({ user: human }));
        const email = user?.profile?.email;
        expect(email).toBeTruthy();
        const found = yield* ok("LookupUserByEmail", { email });
        expect(found.user.id).toBe(human);
      }),
      { tags, timeout: 60_000 },
    );
  });

  describe("ListUsers", () => {
    test(
      "lists the member",
      Effect.gen(function* () {
        const { members } = yield* ok("ListUsers", { limit: 200 });
        expect(members.map((m: { id: string }) => m.id)).toContain(human);
      }),
      { tags, timeout: 60_000 },
    );
  });

  describe("GetUserPresence", () => {
    test(
      "reads presence",
      Effect.gen(function* () {
        const { presence } = yield* ok("GetUserPresence", { user: human });
        expect(["active", "away"]).toContain(presence);
      }),
      { tags, timeout: 60_000 },
    );
  });

  describe("OpenConversation", () => {
    test(
      "opens a DM with the member",
      Effect.gen(function* () {
        const { channel } = yield* ok("OpenConversation", { users: human });
        expect(channel.id).toMatch(/^D/);
      }),
      { tags, timeout: 60_000 },
    );
  });

  describe("ListChannels", () => {
    test(
      "includes the bound channel",
      Effect.gen(function* () {
        const { channelId } = yield* stack;
        const ids: string[] = [];
        let cursor: string | undefined;
        do {
          const page = yield* ok("ListChannels", { types: "public_channel", limit: 200, cursor });
          ids.push(...page.channels.map((c: { id: string }) => c.id));
          cursor = page.response_metadata?.next_cursor || undefined;
        } while (cursor !== undefined && !ids.includes(channelId));
        expect(ids).toContain(channelId);
      }),
      { tags, timeout: 60_000 },
    );
  });

  describe("GetTeamInfo", () => {
    test(
      "reads the workspace",
      Effect.gen(function* () {
        const identity = yield* slack(Auth.testAuth({}));
        const { team } = yield* ok("GetTeamInfo");
        expect(team.id).toBe(identity.team_id);
      }),
      { tags, timeout: 60_000 },
    );
  });

  // Views answer interactions: without a live trigger_id, each binding
  // proves it reached Slack as the bot by failing with the view's own error.
  const view = { type: "modal", title: { type: "plain_text", text: "Test" }, blocks: [] };

  describe("OpenView", () => {
    test(
      "rejects a made-up trigger",
      fails(
        "OpenView",
        { trigger_id: "0000000000.0000000000.00000000000000000000000000000000", view },
        "InvalidTriggerId",
      ),
      { tags, timeout: 60_000 },
    );
  });

  describe("PushView", () => {
    test(
      "rejects a made-up trigger",
      fails(
        "PushView",
        { trigger_id: "0000000000.0000000000.00000000000000000000000000000000", view },
        "InvalidTriggerId",
      ),
      { tags, timeout: 60_000 },
    );
  });

  describe("UpdateView", () => {
    test(
      "rejects an unknown view",
      fails("UpdateView", { view_id: "V0000000000", view }, "NotFound"),
      { tags, timeout: 60_000 },
    );
  });

  describe("PublishView", () => {
    test(
      "publishes the member's Home tab",
      Effect.gen(function* () {
        const { view: published } = yield* ok("PublishView", {
          user_id: human,
          view: {
            type: "home",
            blocks: [{ type: "section", text: { type: "mrkdwn", text: "hi" } }],
          },
        });
        expect(published.type).toBe("home");
      }),
      { tags, timeout: 60_000 },
    );
  });
});
