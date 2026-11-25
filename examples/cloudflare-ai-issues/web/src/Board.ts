import { QueuedMessage, SessionEntry, SessionStatus } from "@alchemy.run/ai/Session";
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
import { replied } from "../../src/Board/Said.ts";
import { WebApi } from "../../src/Board/WebApi.api.ts";
import { issueIn, urlOf } from "./Location.ts";

export type Board = Domain.Api.ClientKey<"WebApi">;
/** One Command per command of the Api, and a read namespace per view and stream. */
export const BoardClient = DomainFoldkit.make(WebApi);

// MODEL

/** One issue as the sidebar lists it. */
export const Listed = Schema.Struct({
  issueId: IssueId,
  title: Schema.String,
  label: Schema.NullOr(Label),
  replies: Schema.Number,
  working: Schema.Boolean,
});
export type Listed = typeof Listed.Type;

export const Flags = Schema.Struct({
  /** The issue the address names, if it names one. */
  issueId: Schema.Option(IssueId),
  page: Schema.String,
  /** The list as the last visit left it, shown until the board answers. */
  issues: Schema.Array(Listed),
});
export type Flags = typeof Flags.Type;

/** What the page knows of one issue. It is kept when another is opened, so coming back is instant. */
export const Thread = Schema.Struct({
  /** The issue itself. Known at once for one this page reported or lists. */
  detail: Schema.Option(
    Schema.Struct({ title: Schema.String, body: Schema.String, label: Schema.NullOr(Label) }),
  ),
  /** Whether its agent is working, and what is queued for it. */
  status: SessionStatus,
  queued: Schema.Array(QueuedMessage),
  /** The agent's transcript so far, and where to resume reading it. */
  items: Schema.Array(SessionEntry),
  cursor: Schema.Option(Schema.Number),
  /** The transcript has been read up to now: what arrives next is live. */
  caughtUp: Schema.Boolean,
});
export type Thread = typeof Thread.Type;

const unread: Thread = {
  detail: Option.none(),
  status: "idle",
  queued: [],
  items: [],
  cursor: Option.none(),
  caughtUp: false,
};

/**
 * Something the person did that the board has not shown back yet. The page
 * shows it at once, and drops it when the board's own copy arrives, or says
 * so when the board refuses it.
 */
export const Pending = Schema.Struct({
  commandId: Schema.String,
  issueId: IssueId,
  kind: Schema.Literals(["issue", "reply"]),
  /** A reply's text. */
  text: Schema.String,
});
export type Pending = typeof Pending.Type;

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
  /** Every issue this page has opened. */
  threads: Schema.Record(IssueId, Thread),
  pending: Schema.Array(Pending),
  error: Schema.Option(Schema.String),
});
export type Model = typeof Model.Type;

/**
 * The open issue's thread. While something this page sent is on its way, its
 * agent is about to work, whatever the board last said.
 */
export const threadOf = (model: Model): Thread =>
  Option.match(model.selected, {
    onNone: () => unread,
    onSome: (issueId) => {
      const known = model.threads[issueId] ?? unread;
      return model.pending.some((pending) => pending.issueId === issueId)
        ? { ...known, status: "working" }
        : known;
    },
  });

/** The sidebar: the board's list, with what this page reported ahead of it. */
export const listOf = (model: Model): ReadonlyArray<Listed & { readonly sending: boolean }> => {
  const known = new Set(model.issues.map((issue) => issue.issueId));
  const ahead = model.pending.flatMap((pending) =>
    pending.kind === "issue" && !known.has(pending.issueId)
      ? [
          {
            issueId: pending.issueId,
            title: Option.match(model.threads[pending.issueId]?.detail ?? Option.none(), {
              onNone: () => "",
              onSome: (detail) => detail.title,
            }),
            label: null,
            replies: 0,
            working: true,
            sending: true,
          },
        ]
      : [],
  );
  return [
    ...ahead,
    ...model.issues.map((issue) => ({
      ...issue,
      // The page knows its own issue's agent is at work before the list says so.
      working:
        issue.working ||
        model.threads[issue.issueId]?.status === "working" ||
        model.pending.some((pending) => pending.issueId === issue.issueId),
      sending: false,
    })),
  ];
};

/** The replies to the open issue that its transcript does not show yet. */
export const sendingOf = (model: Model): ReadonlyArray<Pending> => {
  const thread = threadOf(model);
  const shown = [
    ...thread.queued.map((message) => message.text),
    ...thread.items.flatMap(({ item }) => (item.type === "user" ? [item.text] : [])),
  ];
  return model.pending.filter(
    (pending) =>
      pending.kind === "reply" &&
      Option.contains(model.selected, pending.issueId) &&
      !shown.includes(replied(pending.text)),
  );
};

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
  CompletedRemember: {},
  ReceivedBoardResult: { result: BoardClient.Message },
  ReceivedIssues: { issues: Schema.Array(Listed) },
  ReceivedIssue: { issueId: IssueId, detail: Thread.fields.detail },
  ReceivedStatus: { issueId: IssueId, status: SessionStatus, queued: Schema.Array(QueuedMessage) },
  ReceivedItems: { issueId: IssueId, entries: Schema.Array(SessionEntry), cursor: Schema.Number },
  CaughtUpTranscript: { issueId: IssueId, cursor: Schema.Number },
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

/** Keep the list for the next visit, so it is on screen before the board answers. */
export const Remember = Command.define("Remember", {
  args: { issues: Schema.Array(Listed) },
  messages: [Message.CompletedRemember],
  execute: ({ issues }) =>
    Effect.sync(() => {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(REMEMBERED, JSON.stringify(issues.slice(0, 100)));
      }
      return Message.CompletedRemember();
    }),
});
export const REMEMBERED = "board:issues";

// UPDATE

type Return = Update.Return<Model, Message, Board>;

/** Change what the page knows of one issue. */
const thread = (model: Model, issueId: IssueId, change: (thread: Thread) => Thread): Model =>
  modifyFields(model, {
    threads: (threads) => ({ ...threads, [issueId]: change(threads[issueId] ?? unread) }),
  });

/**
 * Open an issue, or none. Nothing is waited for: an issue this page has open
 * already is shown as it was left, and one it only lists shows its title.
 */
const show = (model: Model, selected: Option.Option<IssueId>): Model =>
  Option.match(selected, {
    onNone: () => modifyFields(model, { selected: () => selected, error: () => Option.none() }),
    onSome: (issueId) => {
      const listed = model.issues.find((issue) => issue.issueId === issueId);
      const opened = thread(model, issueId, (known) =>
        Option.isSome(known.detail) || listed === undefined
          ? known
          : {
              ...known,
              detail: Option.some({ title: listed.title, body: "", label: listed.label }),
              status: listed.working ? "working" : known.status,
            },
      );
      return modifyFields(opened, {
        selected: () => selected,
        reply: () => "",
        error: () => Option.none(),
      });
    },
  });

/** Send one command of the Api, named so that a retry is not run twice. */
const send = (
  model: Model,
  command: (commandId: string) => Command.Command<typeof BoardClient.Message.Type, never, Board>,
): Return & { readonly commandId: string } => {
  const { commandId, commandIds } = DomainFoldkit.next(model.commandIds);
  return {
    commandId,
    model: modifyFields(model, { commandIds: () => commandIds, error: () => Option.none() }),
    commands: [
      Command.mapMessage(command(commandId), (result) => Message.ReceivedBoardResult({ result })),
    ],
  };
};

/** The board refused, or never answered: take back what the page showed ahead of it. */
const undo = (model: Model, commandId: string, reason: string): Model => {
  const refused = model.pending.find((pending) => pending.commandId === commandId);
  const rest = modifyFields(model, {
    pending: (pending) => pending.filter((each) => each.commandId !== commandId),
    error: () => Option.some(reason),
  });
  if (refused === undefined) return rest;
  if (refused.kind === "reply") {
    // The words go back in the box, unless the person has started another.
    return modifyFields(rest, { reply: (reply) => (reply === "" ? refused.text : reply) });
  }
  const written = Option.getOrUndefined(rest.threads[refused.issueId]?.detail ?? Option.none());
  const { [refused.issueId]: _dropped, ...threads } = rest.threads;
  return modifyFields(rest, {
    threads: () => threads,
    selected: (selected) => (Option.contains(selected, refused.issueId) ? Option.none() : selected),
    title: (title) => (title === "" ? (written?.title ?? "") : title),
    body: (body) => (body === "" ? (written?.body ?? "") : body),
  });
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
      const title = model.title.trim();
      const body = model.body.trim();
      if (title === "") return { model };
      // The page names the issue, so it can show it before the board answers.
      const issueId = IssueId.make(
        `${model.commandIds.session}-${model.commandIds.sent}`.replace(/[^\w-]/g, "-"),
      );
      const sent = send(model, (commandId) =>
        BoardClient.ReportIssue({ input: { issueId, title, body }, commandId }),
      );
      // Shown at once: the issue as written, its agent starting, and a place in the list.
      const written = thread(sent.model, issueId, () => ({
        ...unread,
        detail: Option.some({ title, body, label: null }),
        caughtUp: true,
      }));
      return {
        model: modifyFields(written, {
          selected: () => Option.some(issueId),
          title: () => "",
          body: () => "",
          reply: () => "",
          pending: (pending) => [
            ...pending,
            { commandId: sent.commandId, issueId, kind: "issue" as const, text: "" },
          ],
        }),
        commands: [...(sent.commands ?? []), ShowAddress({ issueId: Option.some(issueId) })],
      };
    },
    // A reply is passed to the agent by the same policy. A working agent queues it.
    SubmittedReply: () =>
      Option.match(model.selected, {
        onNone: (): Return => ({ model }),
        onSome: (issueId) => {
          const text = model.reply.trim();
          if (text === "") return { model };
          const sent = send(model, (commandId) =>
            BoardClient.CommentOnIssue({
              input: { issueId, commentId: commandId, body: text },
              commandId,
            }),
          );
          return {
            // Shown at once, with the agent taking it up.
            model: modifyFields(sent.model, {
              reply: () => "",
              pending: (pending) => [
                ...pending,
                { commandId: sent.commandId, issueId, kind: "reply" as const, text },
              ],
            }),
            commands: sent.commands,
          };
        },
      }),
    CompletedShowAddress: () => ({ model }),
    CompletedRemember: () => ({ model }),
    ReceivedBoardResult: ({ result }) => ({
      model:
        result._tag === "FailedReportIssue" || result._tag === "FailedCommentOnIssue"
          ? undo(
              model,
              result.commandId,
              result.failure._tag === "Rejected"
                ? result.failure.rejection._tag
                : "The board did not answer. Your words are back in the box.",
            )
          : model,
    }),
    ReceivedIssues: ({ issues }) => ({
      model: modifyFields(model, { issues: () => issues, listed: () => true }),
      commands: [Remember({ issues })],
    }),
    ReceivedIssue: ({ issueId, detail }) => ({
      // The board's copy replaces the page's, once it has one.
      model: Option.isNone(detail)
        ? model
        : thread(model, issueId, (known) => ({ ...known, detail })),
    }),
    ReceivedStatus: ({ issueId, status, queued }) => ({
      model: thread(model, issueId, (known) => ({
        ...known,
        queued,
        status,
      })),
    }),
    ReceivedItems: ({ issueId, entries, cursor }) => {
      const read = thread(model, issueId, (known) => ({
        ...known,
        items: [
          ...known.items,
          ...entries.filter((entry) => !known.items.some((item) => item.seq === entry.seq)),
        ],
        cursor: Option.some(cursor),
      }));
      // The agent has it: the page's own copy of the reply, or of the issue, is done.
      const texts = entries.flatMap(({ item }) => (item.type === "user" ? [item.text] : []));
      const arrived = read.pending.find(
        (pending) =>
          pending.issueId === issueId &&
          (pending.kind === "issue" ? texts.length > 0 : texts.includes(replied(pending.text))),
      );
      return {
        model:
          arrived === undefined
            ? read
            : modifyFields(read, {
                pending: (pending) => pending.filter((each) => each !== arrived),
              }),
      };
    },
    CaughtUpTranscript: ({ issueId, cursor }) => ({
      model: thread(model, issueId, (known) => ({
        ...known,
        cursor: Option.some(cursor),
        caughtUp: true,
      })),
    }),
    FailedRead: ({ reason }) => ({
      model: modifyFields(model, { error: () => Option.some(reason) }),
    }),
  });

// INIT

export const init = (flags: Flags): Return => ({
  model: show(
    Model.make({
      commandIds: { session: flags.page, sent: 0 },
      issues: flags.issues,
      listed: false,
      selected: Option.none(),
      title: "",
      body: "",
      reply: "",
      threads: {},
      pending: [],
      error: Option.none(),
    }),
    flags.issueId,
  ),
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
    toMessage: ({ state }, issueId): Message =>
      Message.ReceivedIssue({
        issueId,
        detail: Option.map(state, ({ title, body, label }) => ({ title, body, label })),
      }),
    onFailure: failed,
    onDefect: defect,
  }),
  // The board's Triage view: its state is where the session stands, and its
  // events carry the transcript.
  status: BoardClient.Triage.watch({
    key: open,
    isEnabled: isOpen,
    toMessage: ({ state }, issueId): Message =>
      Message.ReceivedStatus({
        issueId: IssueId.make(issueId),
        ...Option.getOrElse(state, () => ({ status: "idle" as const, queued: [] })),
      }),
    onFailure: failed,
    onDefect: defect,
  }),
  transcript: BoardClient.Triage.events({
    key: open,
    isEnabled: isOpen,
    cursor: (model) => threadOf(model).cursor,
    onEntry: ({ event, envelope }): Message =>
      Message.ReceivedItems({
        issueId: IssueId.make(envelope.id),
        entries: event.items,
        cursor: envelope.seq,
      }),
    onCaughtUp: (cursor, issueId): Message =>
      Message.CaughtUpTranscript({ issueId: IssueId.make(issueId), cursor }),
    onFailure: failed,
    onDefect: defect,
  }),
}));
