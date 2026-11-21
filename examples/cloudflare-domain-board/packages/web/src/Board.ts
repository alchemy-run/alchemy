import type * as Domain from "@alchemy.run/domain";
import * as DomainFoldkit from "@alchemy.run/domain/Foldkit";
import { ActorName } from "@board/domain/Actor";
import { BoardApi } from "@board/domain/BoardApi.api";
import { ChannelId } from "@board/domain/Channel/Channel.id";
import { Card } from "@board/domain/Channel/ChannelBoard.view";
import type { TaskStatus } from "@board/domain/Task/TaskStatus";
import { ThreadId } from "@board/domain/Thread/Thread.id";
import { TimelineEntry } from "@board/domain/Thread/ThreadTimeline.view";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Subscription, type Update } from "foldkit";
import type { Document, Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { modifyFields } from "foldkit/struct";

type Board = Domain.Api.ClientKey<"BoardApi">;
type Resources = Board | HttpClient.HttpClient;
export const BoardClient = DomainFoldkit.make(BoardApi);

// MODEL

export const Flags = Schema.Struct({
  /** Who this browser is signed in as; none shows the sign-in form. */
  actor: Schema.Option(ActorName),
  channel: ChannelId,
  session: Schema.String,
});
export type Flags = typeof Flags.Type;

/** One line of the open thread's timeline, with its place in the feed. */
export const Line = Schema.Struct({
  seq: Schema.Number,
  at: Schema.Number,
  kind: TimelineEntry.fields.kind,
  author: ActorName,
  text: Schema.String,
});
export type Line = typeof Line.Type;

export const Draft = Schema.Struct({
  title: Schema.String,
  text: Schema.String,
  labels: Schema.String,
  isTask: Schema.Boolean,
});
export type Draft = typeof Draft.Type;

export const SignIn = Schema.Struct({
  token: Schema.String,
  actor: Schema.String,
  isSending: Schema.Boolean,
  error: Schema.Option(Schema.String),
});

export const Model = Schema.Struct({
  actor: Schema.Option(ActorName),
  signIn: SignIn,
  commandIds: DomainFoldkit.CommandIds,
  channel: ChannelId,
  channelDraft: Schema.String,
  /** The channel's threads, as its ChannelBoard view last pushed them. */
  threads: Schema.Record(ThreadId, Card),
  boardState: Schema.Literals(["Loading", "Live", "Failed"]),
  /** The open thread, and its timeline as read so far. */
  selected: Schema.Option(ThreadId),
  timeline: Schema.Array(Line),
  timelineCursor: Schema.Option(Schema.Number),
  isTimelineLive: Schema.Boolean,
  reply: Schema.String,
  draft: Draft,
  error: Schema.Option(Schema.String),
});
export type Model = typeof Model.Type;

// MESSAGE

export const Message = defineMessageUnion({
  ChangedToken: { value: Schema.String },
  ChangedName: { value: Schema.String },
  SubmittedSignIn: {},
  FailedSignIn: { reason: Schema.String },
  ClickedSignOut: {},
  ChangedChannel: { value: Schema.String },
  SubmittedChannel: {},
  ChangedTitle: { value: Schema.String },
  ChangedText: { value: Schema.String },
  ChangedLabels: { value: Schema.String },
  ToggledTask: { isTask: Schema.Boolean },
  SubmittedDraft: {},
  ClickedThread: { threadId: ThreadId },
  ClickedClose: {},
  ChangedReply: { value: Schema.String },
  SubmittedReply: {},
  ClickedClaim: { threadId: ThreadId },
  ClickedRenew: { threadId: ThreadId },
  ClickedComplete: { threadId: ThreadId },
  ClickedRelease: { threadId: ThreadId },
  ReceivedBoardResult: { result: BoardClient.Message },
  ReceivedBoard: { threads: Schema.Record(ThreadId, Card) },
  FailedBoard: { reason: Schema.String },
  ReceivedLine: { threadId: ThreadId, line: Line },
  CaughtUpTimeline: {},
  FailedTimeline: { reason: Schema.String },
});
export type Message = typeof Message.Type;

// COMMAND

/**
 * Sign this browser in: `/api/session` checks the board's token and sets it,
 * and the name, as `HttpOnly` cookies. Reload, so the app starts over signed
 * in and every live read's WebSocket carries the cookies.
 */
export const SubmitSignIn = Command.define("SubmitSignIn", {
  args: { token: Schema.String, actor: Schema.String },
  messages: [Message.FailedSignIn],
  execute: Effect.fn(function* ({ token, actor }) {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .execute(
        HttpClientRequest.post("/api/session").pipe(
          HttpClientRequest.bodyJsonUnsafe({ token, actor }),
        ),
      )
      .pipe(Effect.option);
    if (Option.isSome(response) && response.value.status === 200) {
      yield* Effect.sync(() => location.reload());
      return yield* Effect.never;
    }
    return Message.FailedSignIn({
      reason: Option.isSome(response) ? "Wrong token, or no name" : "Board unreachable",
    });
  }),
});

/** Sign out: clear the cookies and start over. */
export const SubmitSignOut = Command.define("SubmitSignOut", {
  args: {},
  messages: [],
  execute: Effect.fn(function* () {
    const client = yield* HttpClient.HttpClient;
    yield* client.execute(HttpClientRequest.delete("/api/session")).pipe(Effect.ignore);
    yield* Effect.sync(() => location.reload());
    return yield* Effect.never;
  }),
});

/** Every command's result arrives as a ReceivedBoardResult. */
const received = <E, R>(command: Command.Command<typeof BoardClient.Message.Type, E, R>) =>
  Command.mapMessage(command, (result) => Message.ReceivedBoardResult({ result }));

// UPDATE

type Return = Update.Return<Model, Message, Resources>;

/** Labels typed as `kind=bug, pr=812`. */
export const parseLabels = (text: string): Array<string> =>
  text
    .split(/[\s,]+/)
    .map((label) => label.trim())
    .filter((label) => label.length > 0);

/** Send one command on the open thread, with a fresh id. */
const send = (
  model: Model,
  make: (commandId: string) => Command.Command<typeof BoardClient.Message.Type, never, Board>,
): Return => {
  const { commandId, commandIds } = DomainFoldkit.next(model.commandIds);
  return {
    model: modifyFields(model, { commandIds: () => commandIds, error: () => Option.none() }),
    commands: [received(make(commandId))],
  };
};

/** A refusal names its rejection; anything else may be sent again. */
const failureOf = (result: typeof BoardClient.Message.Type): Option.Option<string> => {
  if (!("failure" in result)) return Option.none();
  const failure = result.failure;
  return Option.some(
    failure._tag === "Rejected"
      ? failure.rejection._tag
      : failure._tag === "Denied"
        ? failure.error._tag
        : "The board did not answer, try again",
  );
};

const open = (model: Model, threadId: ThreadId): Model =>
  modifyFields(model, {
    selected: () => Option.some(threadId),
    timeline: () => [],
    timelineCursor: () => Option.none(),
    isTimelineLive: () => false,
    reply: () => "",
  });

const isOpen = (model: Model, threadId: ThreadId) => Option.contains(model.selected, threadId);

export const emptyDraft: Draft = { title: "", text: "", labels: "", isTask: true };

export const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    ChangedToken: ({ value }) => ({
      model: modifyFields(model, { signIn: (s) => ({ ...s, token: value }) }),
    }),
    ChangedName: ({ value }) => ({
      model: modifyFields(model, { signIn: (s) => ({ ...s, actor: value }) }),
    }),
    SubmittedSignIn: () => ({
      model: modifyFields(model, {
        signIn: (s) => ({ ...s, isSending: true, error: Option.none() }),
      }),
      commands: [SubmitSignIn({ token: model.signIn.token, actor: model.signIn.actor.trim() })],
    }),
    FailedSignIn: ({ reason }) => ({
      model: modifyFields(model, {
        signIn: (s) => ({ ...s, isSending: false, error: Option.some(reason) }),
      }),
    }),
    ClickedSignOut: () => ({ model, commands: [SubmitSignOut({})] }),
    ChangedChannel: ({ value }) => ({ model: modifyFields(model, { channelDraft: () => value }) }),
    SubmittedChannel: () => {
      const channel = model.channelDraft.trim();
      return channel.length === 0 || channel === model.channel
        ? { model }
        : {
            model: modifyFields(model, {
              channel: () => ChannelId.make(channel),
              threads: () => ({}),
              boardState: () => "Loading",
              selected: () => Option.none(),
              timeline: () => [],
              timelineCursor: () => Option.none(),
              isTimelineLive: () => false,
            }),
          };
    },
    ChangedTitle: ({ value }) => ({
      model: modifyFields(model, { draft: (d) => ({ ...d, title: value }) }),
    }),
    ChangedText: ({ value }) => ({
      model: modifyFields(model, { draft: (d) => ({ ...d, text: value }) }),
    }),
    ChangedLabels: ({ value }) => ({
      model: modifyFields(model, { draft: (d) => ({ ...d, labels: value }) }),
    }),
    ToggledTask: ({ isTask }) => ({
      model: modifyFields(model, { draft: (d) => ({ ...d, isTask }) }),
    }),
    SubmittedDraft: () => {
      const { draft } = model;
      if (draft.title.trim().length === 0) return { model };
      const { commandId, commandIds } = DomainFoldkit.next(model.commandIds);
      // The thread's id comes from the command's: unique to this page and send.
      const threadId = ThreadId.make(`t-${commandId.replace(":", "-")}`);
      const input = {
        threadId,
        channel: model.channel,
        title: draft.title.trim(),
        text: draft.text.trim(),
        labels: parseLabels(draft.labels),
      };
      return {
        model: open(
          modifyFields(model, {
            commandIds: () => commandIds,
            draft: () => emptyDraft,
            error: () => Option.none(),
          }),
          threadId,
        ),
        commands: [
          received(
            draft.isTask
              ? BoardClient.CreateTask({ input, commandId })
              : BoardClient.StartThread({ input, commandId }),
          ),
        ],
      };
    },
    ClickedThread: ({ threadId }) => ({
      model: isOpen(model, threadId) ? model : open(model, threadId),
    }),
    ClickedClose: () => ({
      model: modifyFields(model, {
        selected: () => Option.none(),
        timeline: () => [],
        timelineCursor: () => Option.none(),
        isTimelineLive: () => false,
      }),
    }),
    ChangedReply: ({ value }) => ({ model: modifyFields(model, { reply: () => value }) }),
    SubmittedReply: () => {
      const text = model.reply.trim();
      if (Option.isNone(model.selected) || text.length === 0) return { model };
      const threadId = model.selected.value;
      const sent = send(model, (commandId) =>
        BoardClient.PostMessage({ input: { threadId, text }, commandId }),
      );
      return { ...sent, model: modifyFields(sent.model, { reply: () => "" }) };
    },
    ClickedClaim: ({ threadId }) =>
      send(model, (commandId) => BoardClient.ClaimTask({ input: { threadId }, commandId })),
    ClickedRenew: ({ threadId }) =>
      send(model, (commandId) => BoardClient.RenewLease({ input: { threadId }, commandId })),
    ClickedComplete: ({ threadId }) =>
      send(model, (commandId) => BoardClient.CompleteTask({ input: { threadId }, commandId })),
    ClickedRelease: ({ threadId }) =>
      send(model, (commandId) => BoardClient.ReleaseTask({ input: { threadId }, commandId })),
    ReceivedBoardResult: ({ result }) => ({
      model: modifyFields(model, { error: () => failureOf(result) }),
    }),
    ReceivedBoard: ({ threads }) => ({
      model: modifyFields(model, { threads: () => threads, boardState: () => "Live" }),
    }),
    FailedBoard: ({ reason }) => ({
      model: modifyFields(model, { boardState: () => "Failed", error: () => Option.some(reason) }),
    }),
    // A line from a thread that is no longer open is dropped.
    ReceivedLine: ({ threadId, line }) => ({
      model: isOpen(model, threadId)
        ? modifyFields(model, {
            timeline: (lines) => [...lines, line],
            timelineCursor: () => Option.some(line.seq),
          })
        : model,
    }),
    CaughtUpTimeline: () => ({ model: modifyFields(model, { isTimelineLive: () => true }) }),
    FailedTimeline: ({ reason }) => ({
      model: modifyFields(model, { error: () => Option.some(reason) }),
    }),
  });

// INIT

export const init = (flags: Flags): Return => ({
  model: {
    actor: flags.actor,
    signIn: { token: "", actor: "", isSending: false, error: Option.none() },
    commandIds: { session: flags.session, sent: 0 },
    channel: flags.channel,
    channelDraft: flags.channel,
    threads: {},
    boardState: "Loading",
    selected: Option.none(),
    timeline: [],
    timelineCursor: Option.none(),
    isTimelineLive: false,
    reply: "",
    draft: emptyDraft,
    error: Option.none(),
  },
});

// SUBSCRIPTION

const isSignedIn = (model: Model) => Option.isSome(model.actor);
const noThread = ThreadId.make("-");

export const subscriptions = Subscription.make<Model, Message, Resources>()(() => ({
  // The channel's backlog, pushed whenever any of its threads changes.
  board: BoardClient.ChannelBoard.watch({
    key: (model: Model) => model.channel,
    isEnabled: isSignedIn,
    toMessage: ({ state }): Message =>
      Message.ReceivedBoard({
        threads: Option.match(state, { onNone: () => ({}), onSome: (board) => board.threads }),
      }),
    onFailure: (error): Message => Message.FailedBoard({ reason: error._tag }),
    onDefect: (): Message => Message.FailedBoard({ reason: "Read defect" }),
  }),
  // The open thread's conversation, from where the Model has read to.
  timeline: BoardClient.ThreadTimeline.events({
    key: (model: Model) => Option.getOrElse(model.selected, () => noThread),
    cursor: (model) => model.timelineCursor,
    isEnabled: (model) => isSignedIn(model) && Option.isSome(model.selected),
    onEntry: ({ event, envelope }): Message =>
      Message.ReceivedLine({
        threadId: ThreadId.make(envelope.id),
        line: {
          seq: envelope.seq,
          at: DateTime.toEpochMillis(envelope.at),
          kind: event.kind,
          author: event.author,
          text: event.text,
        },
      }),
    onCaughtUp: (): Message => Message.CaughtUpTimeline(),
    onFailure: (error): Message => Message.FailedTimeline({ reason: error._tag }),
    onDefect: (): Message => Message.FailedTimeline({ reason: "Read defect" }),
  }),
}));

// VIEW

type Column = "Conversations" | TaskStatus["_tag"];
const columns: ReadonlyArray<Column> = ["Conversations", "Blocked", "Ready", "Claimed", "Done"];
const columnOf = (card: Card): Column => card.task?._tag ?? "Conversations";

const time = (epochMillis: number) =>
  new Date(epochMillis).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const statusText = (task: TaskStatus | null): string => {
  if (task === null) return "conversation";
  switch (task._tag) {
    case "Blocked":
      return `waiting on ${task.waitingOn.join(", ")}`;
    case "Ready":
      return "ready to claim";
    case "Claimed":
      return `${task.by} until ${time(task.leaseUntil)}`;
    case "Done":
      return `done by ${task.by}`;
  }
};

const cardView = (model: Model, threadId: ThreadId, card: Card, h: HtmlBuilder<Message>): Html =>
  h.keyed("li")(
    threadId,
    [
      h.Class(isOpen(model, threadId) ? "card open" : "card"),
      h.OnClick(Message.ClickedThread({ threadId })),
    ],
    [
      h.strong([], [card.title]),
      h.p([h.Class("muted")], [statusText(card.task)]),
      h.div(
        [h.Class("labels")],
        card.labels.map((label) => h.span([h.Class("label")], [label])),
      ),
      h.p([h.Class("muted")], [`${card.author ?? "?"} · ${card.replies} replies`]),
    ],
  );

const boardView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const entries = Object.entries(model.threads) as Array<[ThreadId, Card]>;
  return h.div(
    [h.Class("columns")],
    columns.map((column) => {
      const cards = entries.filter(([, card]) => columnOf(card) === column);
      return h.keyed("section")(
        column,
        [h.Class("column")],
        [
          h.h2([], [`${column} (${cards.length})`]),
          h.ul(
            [],
            cards.map(([threadId, card]) => cardView(model, threadId, card, h)),
          ),
        ],
      );
    }),
  );
};

/** What the signed-in actor can do to a task, given where it stands. */
const actions = (model: Model, threadId: ThreadId, card: Card, h: HtmlBuilder<Message>) => {
  const button = (label: string, message: Message) =>
    h.button([h.Type("button"), h.OnClick(message)], [label]);
  const task = card.task;
  if (task === null) return [];
  if (task._tag === "Ready") return [button("Claim", Message.ClickedClaim({ threadId }))];
  if (task._tag === "Claimed" && Option.contains(model.actor, task.by)) {
    return [
      button("Renew lease", Message.ClickedRenew({ threadId })),
      button("Complete", Message.ClickedComplete({ threadId })),
      button("Release", Message.ClickedRelease({ threadId })),
    ];
  }
  return [];
};

const threadView = (model: Model, threadId: ThreadId, h: HtmlBuilder<Message>): Html => {
  const card = Option.fromNullishOr(model.threads[threadId]);
  return h.aside(
    [h.Class("thread")],
    [
      h.div(
        [h.Class("thread-head")],
        [
          h.h2([], [Option.match(card, { onNone: () => threadId, onSome: (c) => c.title })]),
          h.button([h.Type("button"), h.OnClick(Message.ClickedClose())], ["Close"]),
        ],
      ),
      ...Option.match(card, {
        onNone: () => [h.p([h.Class("muted")], ["Starting…"])],
        onSome: (card) => [
          h.p(
            [h.Class("muted")],
            [statusText(card.task), model.isTimelineLive ? " · live" : " · catching up"],
          ),
          h.div([h.Class("actions")], actions(model, threadId, card, h)),
        ],
      }),
      h.ol(
        [h.Class("timeline")],
        model.timeline.map((line) =>
          h.keyed("li")(
            line.seq,
            [h.Class(`line ${line.kind}`)],
            [
              h.span([h.Class("author")], [line.author]),
              h.span([h.Class("kind")], [line.kind]),
              h.span([h.Class("muted")], [time(line.at)]),
              h.p([], [line.text]),
            ],
          ),
        ),
      ),
      h.form(
        [h.Class("reply"), h.OnSubmit(Message.SubmittedReply())],
        [
          h.input([
            h.Value(model.reply),
            h.Placeholder("Reply"),
            h.OnInput((value) => Message.ChangedReply({ value })),
          ]),
          h.button([h.Type("submit")], ["Post"]),
        ],
      ),
    ],
  );
};

const draftView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.form(
    [h.Class("draft"), h.OnSubmit(Message.SubmittedDraft())],
    [
      h.input([
        h.Value(model.draft.title),
        h.Placeholder("Title"),
        h.OnInput((value) => Message.ChangedTitle({ value })),
      ]),
      h.input([
        h.Value(model.draft.text),
        h.Placeholder("What needs doing"),
        h.OnInput((value) => Message.ChangedText({ value })),
      ]),
      h.input([
        h.Value(model.draft.labels),
        h.Placeholder("kind=bug, pr=812"),
        h.OnInput((value) => Message.ChangedLabels({ value })),
      ]),
      h.label(
        [],
        [
          h.input([
            h.Type("checkbox"),
            h.Checked(model.draft.isTask),
            h.OnChange(() => Message.ToggledTask({ isTask: !model.draft.isTask })),
          ]),
          "Task",
        ],
      ),
      h.button([h.Type("submit")], [model.draft.isTask ? "Create task" : "Start thread"]),
    ],
  );

const signInView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.main(
    [h.Class("sign-in")],
    [
      h.h1([], ["Board"]),
      h.form(
        [h.OnSubmit(Message.SubmittedSignIn())],
        [
          h.input([
            h.Value(model.signIn.actor),
            h.Placeholder("Your name"),
            h.OnInput((value) => Message.ChangedName({ value })),
          ]),
          h.input([
            h.Type("password"),
            h.Value(model.signIn.token),
            h.Placeholder("Board token"),
            h.OnInput((value) => Message.ChangedToken({ value })),
          ]),
          h.button([h.Type("submit"), h.Disabled(model.signIn.isSending)], ["Sign in"]),
        ],
      ),
      h.p([h.Class("error")], [Option.getOrElse(model.signIn.error, () => "")]),
      h.p(
        [h.Class("muted")],
        ["The token is the stack's token output. Agents use the same board over /mcp."],
      ),
    ],
  );

export const view = (model: Model, h: HtmlBuilder<Message>): Document =>
  Option.match(model.actor, {
    onNone: () => ({ title: "Board: sign in", body: signInView(model, h) }),
    onSome: (actor) => ({
      title: `#${model.channel}`,
      body: h.main(
        [h.Class("app")],
        [
          h.header(
            [],
            [
              h.form(
                [h.Class("channel"), h.OnSubmit(Message.SubmittedChannel())],
                [
                  h.span([], ["#"]),
                  h.input([
                    h.Value(model.channelDraft),
                    h.OnInput((value) => Message.ChangedChannel({ value })),
                  ]),
                ],
              ),
              h.span(
                [h.Class("muted")],
                [model.boardState === "Live" ? "live" : model.boardState.toLowerCase()],
              ),
              h.span([h.Class("who")], [actor]),
              h.button([h.Type("button"), h.OnClick(Message.ClickedSignOut())], ["Sign out"]),
            ],
          ),
          draftView(model, h),
          h.p([h.Class("error")], [Option.getOrElse(model.error, () => "")]),
          h.div(
            [h.Class("layout")],
            [
              boardView(model, h),
              ...Option.toArray(Option.map(model.selected, (id) => threadView(model, id, h))),
            ],
          ),
        ],
      ),
    }),
  });
