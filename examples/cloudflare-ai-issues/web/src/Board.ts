import { QueuedMessage, SessionEntry } from "@alchemy.run/ai/Session";
import type * as Domain from "@alchemy.run/domain";
import * as DomainFoldkit from "@alchemy.run/domain/Foldkit";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Subscription, type Update } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import { modifyFields } from "foldkit/struct";
import { IssueId } from "../../src/Board/Issue.id.ts";
import { ALL } from "../../src/Board/IssueList.view.ts";
import { Label } from "../../src/Board/LabelIssue.command.ts";
import { Status } from "../../src/Board/RecordActivity.command.ts";
import { WebApi } from "../../src/Board/WebApi.api.ts";
import { issueIn, urlOf } from "./Location.ts";

export type Board = Domain.Api.ClientKey<"WebApi">;
/** One Command per command of the Api, and a read namespace per view and stream. */
export const BoardClient = DomainFoldkit.make(WebApi);

// MODEL

export const Flags = Schema.Struct({
  /** The issue the address names, if it names one. */
  issueId: Schema.Option(IssueId),
  page: Schema.String,
});
export type Flags = typeof Flags.Type;

/** One issue as the sidebar lists it. */
export const Listed = Schema.Struct({
  issueId: IssueId,
  title: Schema.String,
  label: Schema.NullOr(Label),
  replies: Schema.Number,
  working: Schema.Boolean,
});
export type Listed = typeof Listed.Type;

export const Model = Schema.Struct({
  commandIds: DomainFoldkit.CommandIds,
  /** Every issue of the board, newest first. */
  issues: Schema.Array(Listed),
  listed: Schema.Boolean,
  /** The issue that is open. None shows the form for a new one. */
  selected: Schema.Option(IssueId),
  /** The new issue being written. */
  title: Schema.String,
  body: Schema.String,
  /** The reply being written. */
  reply: Schema.String,
  /** The open issue, once the board has it. */
  detail: Schema.Option(
    Schema.Struct({ title: Schema.String, body: Schema.String, label: Schema.NullOr(Label) }),
  ),
  /** Whether its agent is working, and what is queued for it. */
  status: Status,
  queued: Schema.Array(QueuedMessage),
  /** The agent's transcript so far, and where to resume reading it. */
  items: Schema.Array(SessionEntry),
  cursor: Schema.Option(Schema.Number),
  /** The transcript has been read up to now: what arrives next is live. */
  caughtUp: Schema.Boolean,
  error: Schema.Option(Schema.String),
});
export type Model = typeof Model.Type;

// MESSAGE

export const Message = defineMessageUnion({
  ClickedNewIssue: {},
  ClickedIssue: { issueId: IssueId },
  /** The browser's back or forward button moved to another address. */
  ChangedAddress: { issueId: Schema.Option(IssueId) },
  ChangedTitle: { text: Schema.String },
  ChangedBody: { text: Schema.String },
  ChangedReply: { text: Schema.String },
  SubmittedIssue: {},
  SubmittedReply: {},
  CompletedShowAddress: {},
  ReceivedBoardResult: { result: BoardClient.Message },
  ReceivedIssues: { issues: Schema.Array(Listed) },
  ReceivedIssue: { detail: Model.fields.detail },
  ReceivedStatus: { status: Status, queued: Schema.Array(QueuedMessage) },
  ReceivedItem: { issueId: IssueId, entry: SessionEntry, cursor: Schema.Number },
  CaughtUpTranscript: { cursor: Schema.Number },
  FailedRead: { reason: Schema.String },
});
export type Message = typeof Message.Type;

// COMMAND

/** Put the open issue in the address bar, so a refresh or a shared link opens it. */
export const ShowAddress = Command.define("ShowAddress", {
  args: { issueId: Schema.Option(IssueId) },
  messages: [Message.CompletedShowAddress],
  execute: ({ issueId }) =>
    Effect.sync(() => {
      if (typeof history !== "undefined") {
        history.pushState(null, "", urlOf(location.href, issueId));
      }
      return Message.CompletedShowAddress();
    }),
});

// UPDATE

type Return = Update.Return<Model, Message, Board>;

/** Open an issue, or none: what was read of the last one is dropped. */
const show = (model: Model, selected: Option.Option<IssueId>): Model =>
  Option.getOrNull(model.selected) === Option.getOrNull(selected)
    ? model
    : modifyFields(model, {
        selected: () => selected,
        detail: () => Option.none(),
        status: () => "idle",
        queued: () => [],
        items: () => [],
        cursor: () => Option.none(),
        caughtUp: () => false,
        reply: () => "",
        error: () => Option.none(),
      });

/** Send one command of the Api, named so that a retry is not run twice. */
const send = (
  model: Model,
  command: (commandId: string) => Command.Command<typeof BoardClient.Message.Type, never, Board>,
): Return => {
  const { commandId, commandIds } = DomainFoldkit.next(model.commandIds);
  return {
    model: modifyFields(model, { commandIds: () => commandIds, error: () => Option.none() }),
    commands: [
      Command.mapMessage(command(commandId), (result) => Message.ReceivedBoardResult({ result })),
    ],
  };
};

export const update = (model: Model, message: Message) =>
  Message.match<Return>(message, {
    ClickedNewIssue: () => ({
      model: show(model, Option.none()),
      commands: [ShowAddress({ issueId: Option.none() })],
    }),
    ClickedIssue: ({ issueId }) => ({
      model: show(model, Option.some(issueId)),
      commands: [ShowAddress({ issueId: Option.some(issueId) })],
    }),
    ChangedAddress: ({ issueId }) => ({ model: show(model, issueId) }),
    ChangedTitle: ({ text }) => ({ model: modifyFields(model, { title: () => text }) }),
    ChangedBody: ({ text }) => ({ model: modifyFields(model, { body: () => text }) }),
    ChangedReply: ({ text }) => ({ model: modifyFields(model, { reply: () => text }) }),
    // Reporting the issue is what starts its agent: the board's policy does that.
    SubmittedIssue: () => {
      if (model.title.trim() === "") return { model };
      // The page names the issue, so it can open it before the board answers.
      const issueId = IssueId.make(
        `${model.commandIds.session}-${model.commandIds.sent}`.replace(/[^\w-]/g, "-"),
      );
      const sent = send(model, (commandId) =>
        BoardClient.ReportIssue({
          input: { issueId, title: model.title.trim(), body: model.body.trim() },
          commandId,
        }),
      );
      return {
        model: modifyFields(show(sent.model, Option.some(issueId)), {
          title: () => "",
          body: () => "",
        }),
        commands: [...(sent.commands ?? []), ShowAddress({ issueId: Option.some(issueId) })],
      };
    },
    // A reply is passed to the agent by the same policy. A working agent queues it.
    SubmittedReply: () =>
      Option.match(model.selected, {
        onNone: (): Return => ({ model }),
        onSome: (issueId) => {
          if (model.reply.trim() === "") return { model };
          const sent = send(model, (commandId) =>
            BoardClient.CommentOnIssue({
              input: { issueId, commentId: commandId, body: model.reply.trim() },
              commandId,
            }),
          );
          return { ...sent, model: modifyFields(sent.model, { reply: () => "" }) };
        },
      }),
    CompletedShowAddress: () => ({ model }),
    ReceivedBoardResult: ({ result }) => ({
      model:
        result._tag === "FailedReportIssue" || result._tag === "FailedCommentOnIssue"
          ? modifyFields(model, {
              error: () =>
                Option.some(
                  result.failure._tag === "Rejected"
                    ? result.failure.rejection._tag
                    : "The board did not answer. Try again.",
                ),
            })
          : model,
    }),
    ReceivedIssues: ({ issues }) => ({
      model: modifyFields(model, { issues: () => issues, listed: () => true }),
    }),
    ReceivedIssue: ({ detail }) => ({ model: modifyFields(model, { detail: () => detail }) }),
    ReceivedStatus: ({ status, queued }) => ({
      model: modifyFields(model, { status: () => status, queued: () => queued }),
    }),
    ReceivedItem: ({ issueId, entry, cursor }) => ({
      // An entry of the issue that was open a moment ago is not this one's.
      model: Option.contains(model.selected, issueId)
        ? modifyFields(model, {
            items: (items) => [...items, entry],
            cursor: () => Option.some(cursor),
          })
        : model,
    }),
    CaughtUpTranscript: ({ cursor }) => ({
      model: modifyFields(model, { cursor: () => Option.some(cursor), caughtUp: () => true }),
    }),
    FailedRead: ({ reason }) => ({
      model: modifyFields(model, { error: () => Option.some(reason) }),
    }),
  });

// INIT

export const init = (flags: Flags): Return => ({
  model: Model.make({
    commandIds: { session: flags.page, sent: 0 },
    issues: [],
    listed: false,
    selected: flags.issueId,
    title: "",
    body: "",
    reply: "",
    detail: Option.none(),
    status: "idle",
    queued: [],
    items: [],
    cursor: Option.none(),
    caughtUp: false,
    error: Option.none(),
  }),
});

// SUBSCRIPTION

const open = (model: Model) => Option.getOrElse(model.selected, () => IssueId.make(""));
const isOpen = (model: Model) => Option.isSome(model.selected);
const failed = (error: { readonly _tag: string }): Message =>
  Message.FailedRead({ reason: error._tag });
const defect = (): Message => Message.FailedRead({ reason: "The board could not be read" });

export const subscriptions = Subscription.make<Model, Message, Board>()((entry) => ({
  // Back and forward open the issue their address names.
  address: entry(
    {},
    {
      modelToDependencies: () => ({}),
      dependenciesToStream: () =>
        typeof window === "undefined"
          ? Stream.empty
          : Stream.fromEventListener(window, "popstate").pipe(
              Stream.map(() => Message.ChangedAddress({ issueId: issueIn(location.href) })),
            ),
    },
  ),
  issues: BoardClient.IssueList.watch({
    key: () => ALL,
    toMessage: ({ state }): Message =>
      Message.ReceivedIssues({
        issues: Option.match(state, {
          onNone: () => [],
          onSome: (list) =>
            list.order.flatMap((issueId) => {
              const issue = list.issues[issueId];
              return issue === undefined
                ? []
                : [{ issueId, ...issue, working: list.working.includes(issueId) }];
            }),
        }),
      }),
    onFailure: failed,
    onDefect: defect,
  }),
  issue: BoardClient.IssueDetail.watch({
    key: open,
    isEnabled: isOpen,
    toMessage: ({ state }): Message =>
      Message.ReceivedIssue({
        detail: Option.map(state, ({ title, body, label }) => ({ title, body, label })),
      }),
    onFailure: failed,
    onDefect: defect,
  }),
  status: BoardClient.SessionStatus.watch({
    key: open,
    isEnabled: isOpen,
    toMessage: ({ state }): Message =>
      Message.ReceivedStatus(
        Option.getOrElse(state, () => ({ status: "idle" as const, queued: [] })),
      ),
    onFailure: failed,
    onDefect: defect,
  }),
  transcript: BoardClient.Transcript.events({
    key: open,
    isEnabled: isOpen,
    cursor: (model) => model.cursor,
    onEntry: ({ event, envelope }): Message =>
      Message.ReceivedItem({
        issueId: IssueId.make(envelope.id),
        entry: { seq: event.seq, item: event.item },
        cursor: envelope.seq,
      }),
    onCaughtUp: (cursor): Message => Message.CaughtUpTranscript({ cursor }),
    onFailure: failed,
    onDefect: defect,
  }),
}));
