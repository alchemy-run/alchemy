import { QueuedMessage, SessionEntry, SessionEvent } from "@alchemy.run/ai/Session";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Subscription, type Update } from "foldkit";
import type { Document, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { modifyFields } from "foldkit/struct";
import { Chat, follow } from "./Client.ts";

// MODEL

export const Flags = Schema.Struct({ page: Schema.String });

export const Model = Schema.Struct({
  /** Names this page's messages, so a retry is never run twice. */
  page: Schema.String,
  sent: Schema.Number,
  draft: Schema.String,
  status: Schema.Literals(["idle", "working"]),
  queued: Schema.Array(QueuedMessage),
  items: Schema.Array(SessionEntry),
  error: Schema.Option(Schema.String),
});
export type Model = typeof Model.Type;

// MESSAGE

export const Message = defineMessageUnion({
  ChangedDraft: { text: Schema.String },
  ClickedSend: {},
  ClickedSteer: {},
  ClickedStop: {},
  ClickedWithdraw: { id: Schema.String },
  ReceivedSessionEvent: { event: SessionEvent },
  CompletedAct: {},
  FailedSession: { reason: Schema.String },
});
export type Message = typeof Message.Type;

// COMMAND

const completed = <E>(effect: Effect.Effect<void, E, Chat>) =>
  effect.pipe(
    Effect.as(Message.CompletedAct()),
    Effect.catch(() => Effect.succeed(Message.FailedSession({ reason: "Not delivered" }))),
  );

const Text = { text: Schema.String, requestId: Schema.String };

/** Queued behind the turn that is running. */
export const Send = Command.define("Send", {
  args: Text,
  messages: [Message.CompletedAct, Message.FailedSession],
  execute: (message) => completed(Effect.flatMap(Chat, (chat) => chat.send(message))),
});

/** Read by the turn that is running, at its next step. */
export const Steer = Command.define("Steer", {
  args: Text,
  messages: [Message.CompletedAct, Message.FailedSession],
  execute: (message) => completed(Effect.flatMap(Chat, (chat) => chat.steer(message))),
});

export const Withdraw = Command.define("Withdraw", {
  args: { id: Schema.String },
  messages: [Message.CompletedAct, Message.FailedSession],
  execute: ({ id }) => completed(Effect.flatMap(Chat, (chat) => chat.withdraw({ id }))),
});

export const Stop = Command.define("Stop", {
  messages: [Message.CompletedAct, Message.FailedSession],
  execute: completed(Effect.flatMap(Chat, (chat) => chat.interrupt())),
});

// UPDATE

type Return = Update.Return<Model, Message, Chat>;

/** A message is named after the page and its count, so a retry is not run twice. */
const say = (model: Model, command: typeof Send | typeof Steer): Return => ({
  model: modifyFields(model, { sent: (sent) => sent + 1, draft: () => "" }),
  commands: [command({ text: model.draft, requestId: `${model.page}:${model.sent}` })],
});

export const update = (model: Model, message: Message) =>
  Message.match<Return>(message, {
    ChangedDraft: ({ text }) => ({ model: modifyFields(model, { draft: () => text }) }),
    ClickedSend: () => say(model, Send),
    ClickedSteer: () => say(model, Steer),
    ClickedStop: () => ({ model, commands: [Stop()] }),
    ClickedWithdraw: ({ id }) => ({ model, commands: [Withdraw({ id })] }),
    ReceivedSessionEvent: ({ event }) => ({
      model:
        event.type === "status"
          ? modifyFields(model, { status: () => event.status, queued: () => event.queued })
          : modifyFields(model, {
              items: (items) => [...items, { seq: event.seq, item: event.item }],
            }),
    }),
    CompletedAct: () => ({ model }),
    FailedSession: ({ reason }) => ({
      model: modifyFields(model, { error: () => Option.some(reason) }),
    }),
  });

// INIT

export const init = (flags: typeof Flags.Type): Return => ({
  model: Model.make({
    page: flags.page,
    sent: 0,
    draft: "",
    status: "idle",
    queued: [],
    items: [],
    error: Option.none(),
  }),
});

// SUBSCRIPTION

export const subscriptions = Subscription.make<Model, Message, Chat>()((entry) => ({
  session: entry(
    {},
    {
      modelToDependencies: () => ({}),
      // The status, every item, then each new one. It resumes by itself after a reconnect.
      dependenciesToStream: () =>
        follow().pipe(
          Stream.map((event) => Message.ReceivedSessionEvent({ event })),
          Stream.catch((error) => Stream.succeed(Message.FailedSession({ reason: error.message }))),
        ),
    },
  ),
}));

// VIEW

const itemView = ({ seq, item }: SessionEntry, h: HtmlBuilder<Message>) =>
  h.keyed("li")(
    String(seq),
    [],
    [
      item.type === "tool"
        ? `${item.name}: ${item.output}`
        : item.type === "assistant" && item.toolCalls.length > 0
          ? `calls ${item.toolCalls.map((call) => call.name).join(", ")}`
          : item.text,
    ],
  );

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: model.status === "working" ? "Working" : "Idle",
  body: h.div(
    [],
    [
      h.ul(
        [],
        model.items.map((entry) => itemView(entry, h)),
      ),
      h.ul(
        [],
        model.queued.map((message) =>
          h.keyed("li")(
            message.id,
            [],
            [
              `${message.delivery}: ${message.text}`,
              h.button([h.OnClick(Message.ClickedWithdraw({ id: message.id }))], ["Withdraw"]),
            ],
          ),
        ),
      ),
      h.input([h.Value(model.draft), h.OnInput((text) => Message.ChangedDraft({ text }))]),
      h.button([h.OnClick(Message.ClickedSend())], ["Send"]),
      ...(model.status === "working"
        ? [
            h.button([h.OnClick(Message.ClickedSteer())], ["Steer"]),
            h.button([h.OnClick(Message.ClickedStop())], ["Stop"]),
          ]
        : []),
      h.p([], [Option.getOrElse(model.error, () => "")]),
    ],
  ),
});
