import * as AIFoldkit from "@alchemy.run/ai/Foldkit";
import { QueuedMessage, SessionEntry, SessionEvent } from "@alchemy.run/ai/Session";
import * as AI from "@alchemy.run/ai/SessionRpcs";
import * as Array from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Subscription, type Update } from "foldkit";
import type { Document, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { modifyFields } from "foldkit/struct";

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
  ReceivedSessionResult: { result: AIFoldkit.Message },
  FailedSession: { reason: Schema.String },
});
export type Message = typeof Message.Type;

// UPDATE

type Return = Update.Return<Model, Message, AI.SessionClient>;

const act = (
  model: Model,
  command: (requestId: string) => Command.Command<AIFoldkit.Message, never, AI.SessionClient>,
): Return => ({
  model: modifyFields(model, { sent: (sent) => sent + 1, draft: () => "" }),
  commands: [
    Command.mapMessage(command(`${model.page}:${model.sent}`), (result) =>
      Message.ReceivedSessionResult({ result }),
    ),
  ],
});

export const update = (model: Model, message: Message) =>
  Message.match<Return>(message, {
    ChangedDraft: ({ text }) => ({ model: modifyFields(model, { draft: () => text }) }),
    // Queued behind the turn that is running.
    ClickedSend: () => act(model, (requestId) => AIFoldkit.Send({ text: model.draft, requestId })),
    // Read by the turn that is running, at its next step.
    ClickedSteer: () =>
      act(model, (requestId) => AIFoldkit.Steer({ text: model.draft, requestId })),
    ClickedStop: () => act(model, (requestId) => AIFoldkit.Interrupt({ requestId })),
    ClickedWithdraw: ({ id }) => act(model, (requestId) => AIFoldkit.Withdraw({ id, requestId })),
    ReceivedSessionEvent: ({ event }) => ({
      model:
        event.type === "status"
          ? modifyFields(model, { status: () => event.status, queued: () => event.queued })
          : modifyFields(model, {
              items: (items) => [...items, { seq: event.seq, item: event.item }],
            }),
    }),
    ReceivedSessionResult: ({ result }) => ({
      model:
        result._tag === "FailedSession"
          ? modifyFields(model, { error: () => Option.some(result.reason) })
          : model,
    }),
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

export const subscriptions = Subscription.make<Model, Message, AI.SessionClient>()(() => ({
  session: AIFoldkit.events({
    // The last item the Model holds: a reconnect resumes after it.
    cursor: (model: Model) => Option.map(Array.last(model.items), (entry) => entry.seq),
    onEvent: (event): Message => Message.ReceivedSessionEvent({ event }),
    onFailure: (reason): Message => Message.FailedSession({ reason }),
  }),
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
