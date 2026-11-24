import { QueuedMessage, SessionEntry } from "@alchemy.run/ai/Session";
import type * as Domain from "@alchemy.run/domain";
import * as DomainFoldkit from "@alchemy.run/domain/Foldkit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Subscription, type Update } from "foldkit";
import type { Document, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { modifyFields } from "foldkit/struct";
import { IssueId } from "../../src/Board/Issue.id.ts";
import { Label } from "../../src/Board/LabelIssue.command.ts";
import { Status } from "../../src/Board/RecordActivity.command.ts";
import { WebApi } from "../../src/Board/WebApi.api.ts";

type Board = Domain.Api.ClientKey<"WebApi">;
/** One Command per command of the Api, and a read namespace per view and stream. */
export const BoardClient = DomainFoldkit.make(WebApi);

// MODEL

export const Flags = Schema.Struct({ issueId: IssueId, page: Schema.String });
export type Flags = typeof Flags.Type;

export const Model = Schema.Struct({
  issueId: IssueId,
  commandIds: DomainFoldkit.CommandIds,
  draft: Schema.String,
  /** The issue, once it is reported. */
  title: Schema.Option(Schema.String),
  label: Schema.Option(Label),
  /** Whether the issue's session is working, and what is queued for it. */
  status: Status,
  queued: Schema.Array(QueuedMessage),
  /** The session's transcript so far, and where to resume reading it. */
  items: Schema.Array(SessionEntry),
  cursor: Schema.Option(Schema.Number),
  error: Schema.Option(Schema.String),
});
export type Model = typeof Model.Type;

// MESSAGE

export const Message = defineMessageUnion({
  ChangedDraft: { text: Schema.String },
  ClickedReport: {},
  ClickedReply: {},
  ReceivedBoardResult: { result: BoardClient.Message },
  ReceivedIssue: { title: Schema.Option(Schema.String), label: Schema.Option(Label) },
  ReceivedStatus: { status: Status, queued: Schema.Array(QueuedMessage) },
  ReceivedItem: { entry: SessionEntry, cursor: Schema.Number },
  CaughtUpTranscript: { cursor: Schema.Number },
  FailedRead: { reason: Schema.String },
});
export type Message = typeof Message.Type;

// UPDATE

type Return = Update.Return<Model, Message, Board>;

/** Send one command of the Api, named so that a retry is not run twice. */
const send = (
  model: Model,
  command: (commandId: string) => Command.Command<typeof BoardClient.Message.Type, never, Board>,
): Return => {
  const { commandId, commandIds } = DomainFoldkit.next(model.commandIds);
  return {
    model: modifyFields(model, {
      commandIds: () => commandIds,
      draft: () => "",
      error: () => Option.none(),
    }),
    commands: [
      Command.mapMessage(command(commandId), (result) => Message.ReceivedBoardResult({ result })),
    ],
  };
};

export const update = (model: Model, message: Message) =>
  Message.match<Return>(message, {
    ChangedDraft: ({ text }) => ({ model: modifyFields(model, { draft: () => text }) }),
    // Reporting the issue is what starts its session: the board's policy does that.
    ClickedReport: () =>
      send(model, (commandId) =>
        BoardClient.ReportIssue({
          input: { issueId: model.issueId, title: model.draft, body: "" },
          commandId,
        }),
      ),
    // A reply is passed to the session by the same policy. A working session queues it.
    ClickedReply: () =>
      send(model, (commandId) =>
        BoardClient.CommentOnIssue({
          input: { issueId: model.issueId, commentId: commandId, body: model.draft },
          commandId,
        }),
      ),
    ReceivedBoardResult: ({ result }) => ({
      model:
        result._tag === "FailedReportIssue" || result._tag === "FailedCommentOnIssue"
          ? modifyFields(model, { error: () => Option.some(result.failure._tag) })
          : model,
    }),
    ReceivedIssue: ({ title, label }) => ({
      model: modifyFields(model, { title: () => title, label: () => label }),
    }),
    ReceivedStatus: ({ status, queued }) => ({
      model: modifyFields(model, { status: () => status, queued: () => queued }),
    }),
    ReceivedItem: ({ entry, cursor }) => ({
      model: modifyFields(model, {
        items: (items) => [...items, entry],
        cursor: () => Option.some(cursor),
      }),
    }),
    CaughtUpTranscript: ({ cursor }) => ({
      model: modifyFields(model, { cursor: () => Option.some(cursor) }),
    }),
    FailedRead: ({ reason }) => ({
      model: modifyFields(model, { error: () => Option.some(reason) }),
    }),
  });

// INIT

export const init = (flags: Flags): Return => ({
  model: Model.make({
    issueId: flags.issueId,
    commandIds: { session: flags.page, sent: 0 },
    draft: "",
    title: Option.none(),
    label: Option.none(),
    status: "idle",
    queued: [],
    items: [],
    cursor: Option.none(),
    error: Option.none(),
  }),
});

// SUBSCRIPTION

export const subscriptions = Subscription.make<Model, Message, Board>()(() => ({
  issue: BoardClient.IssueDetail.watch({
    key: (model: Model) => model.issueId,
    toMessage: ({ state }): Message =>
      Message.ReceivedIssue({
        title: Option.map(state, (detail) => detail.title),
        label: Option.flatMap(state, (detail) => Option.fromNullishOr(detail.label)),
      }),
    onFailure: (error): Message => Message.FailedRead({ reason: error._tag }),
    onDefect: (): Message => Message.FailedRead({ reason: "Read defect" }),
  }),
  status: BoardClient.SessionStatus.watch({
    key: (model: Model) => model.issueId,
    toMessage: ({ state }): Message =>
      Message.ReceivedStatus(
        Option.getOrElse(state, () => ({ status: "idle" as const, queued: [] })),
      ),
    onFailure: (error): Message => Message.FailedRead({ reason: error._tag }),
    onDefect: (): Message => Message.FailedRead({ reason: "Read defect" }),
  }),
  transcript: BoardClient.Transcript.events({
    key: (model: Model) => model.issueId,
    cursor: (model) => model.cursor,
    onEntry: ({ event, envelope }): Message =>
      Message.ReceivedItem({ entry: { seq: event.seq, item: event.item }, cursor: envelope.seq }),
    onCaughtUp: (cursor): Message => Message.CaughtUpTranscript({ cursor }),
    onFailure: (error): Message => Message.FailedRead({ reason: error._tag }),
    onDefect: (): Message => Message.FailedRead({ reason: "Read defect" }),
  }),
}));

// VIEW

const itemView = ({ seq, item }: SessionEntry, h: HtmlBuilder<Message>) =>
  h.keyed("li")(
    String(seq),
    [],
    [
      item.type === "user"
        ? `You: ${item.text}`
        : item.type === "tool"
          ? `${item.name} answered: ${item.output}`
          : item.toolCalls.length > 0
            ? `Calls ${item.toolCalls.map((call) => call.name).join(", ")}`
            : `Agent: ${item.text}`,
    ],
  );

export const view = (model: Model, h: HtmlBuilder<Message>): Document => {
  const reported = Option.isSome(model.title);
  return {
    title: Option.getOrElse(model.title, () => "New issue"),
    body: h.div(
      [],
      [
        h.h1([], [Option.getOrElse(model.title, () => `Issue ${model.issueId}`)]),
        h.p([], [`Label: ${Option.getOrElse(model.label, () => "none yet")}`]),
        h.p([], [model.status === "working" ? "The agent is working" : "The agent is idle"]),
        h.ul(
          [],
          model.items.map((entry) => itemView(entry, h)),
        ),
        h.ul(
          [],
          model.queued.map((message) => h.keyed("li")(message.id, [], [`Queued: ${message.text}`])),
        ),
        h.input([h.Value(model.draft), h.OnInput((text) => Message.ChangedDraft({ text }))]),
        reported
          ? h.button([h.OnClick(Message.ClickedReply())], ["Reply"])
          : h.button([h.OnClick(Message.ClickedReport())], ["Report this issue"]),
        h.p([], [Option.getOrElse(model.error, () => "")]),
      ],
    ),
  };
};
