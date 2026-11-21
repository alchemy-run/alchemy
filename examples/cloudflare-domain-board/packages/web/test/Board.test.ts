import { ActorName } from "@board/domain/Actor";
import { ChannelId } from "@board/domain/Channel/Channel.id";
import type { Card } from "@board/domain/Channel/ChannelBoard.view";
import { ThreadId } from "@board/domain/Thread/Thread.id";
import { expect, test } from "@effect/vitest";
import * as Option from "effect/Option";
import { Command, given, message, model, story } from "foldkit/story";
import { modifyFields } from "foldkit/struct";
import {
  BoardClient,
  init,
  Message,
  type Model,
  parseLabels,
  SubmitSignIn,
  update,
} from "../src/Board.ts";

const fixer = ActorName.make("fixer");
const t1 = ThreadId.make("t-1");

const signedIn: Model = init({
  actor: Option.some(fixer),
  channel: ChannelId.make("dev"),
  session: "s",
}).model;

const ready: Card = {
  title: "Checkout 500s",
  author: ActorName.make("sam"),
  labels: ["kind=bug"],
  task: { _tag: "Ready" },
  replies: 0,
};

const receipt = (stream: string) => ({
  reply: undefined,
  receipt: { stream, version: 1 },
  commits: [{ stream, version: 1 }],
});

test("signing in sends the token and name; a wrong token says so", () =>
  story(
    update,
    given(modifyFields(signedIn, { actor: () => Option.none() })),
    message(Message.ChangedName({ value: " fixer " })),
    message(Message.ChangedToken({ value: "wrong" })),
    message(Message.SubmittedSignIn()),
    model((model) => expect(model.signIn.isSending).toBe(true)),
    Command.resolve(SubmitSignIn, Message.FailedSignIn({ reason: "Wrong token, or no name" })),
    model((model) =>
      expect(model.signIn).toMatchObject({
        actor: " fixer ",
        isSending: false,
        error: Option.some("Wrong token, or no name"),
      }),
    ),
  ));

test("a new task is created in the channel and opens", () =>
  story(
    update,
    given(signedIn),
    message(Message.ChangedTitle({ value: "Checkout 500s" })),
    message(Message.ChangedText({ value: "POST /checkout fails for EU carts" })),
    message(Message.ChangedLabels({ value: "kind=bug, area=checkout" })),
    message(Message.SubmittedDraft()),
    model((model) => {
      expect(model.selected).toEqual(Option.some(ThreadId.make("t-s-0")));
      expect(model.draft.title).toBe("");
    }),
    Command.resolve(
      BoardClient.CreateTask,
      BoardClient.Message.SucceededCreateTask({ commandId: "s:0", ...receipt("Thread/t-s-0") }),
    ),
    model((model) => expect(model.error).toEqual(Option.none())),
    // The ChannelBoard watch brings it onto the board.
    message(Message.ReceivedBoard({ threads: { [ThreadId.make("t-s-0")]: ready } })),
    model((model) => expect(model.boardState).toBe("Live")),
  ));

test("a claim another agent won shows its rejection", () =>
  story(
    update,
    given(modifyFields(signedIn, { threads: () => ({ [t1]: ready }) })),
    message(Message.ClickedThread({ threadId: t1 })),
    message(Message.ClickedClaim({ threadId: t1 })),
    Command.resolve(
      BoardClient.ClaimTask,
      BoardClient.Message.FailedClaimTask({
        commandId: "s:0",
        failure: {
          _tag: "Rejected",
          rejection: { _tag: "AlreadyClaimed", by: ActorName.make("reviewer"), leaseUntil: 0 },
        },
      }),
    ),
    model((model) => expect(model.error).toEqual(Option.some("AlreadyClaimed"))),
  ));

test("a reply is posted to the open thread, and its line arrives on the timeline", () =>
  story(
    update,
    given(modifyFields(signedIn, { threads: () => ({ [t1]: ready }) })),
    message(Message.ClickedThread({ threadId: t1 })),
    message(Message.ChangedReply({ value: "Working on it." })),
    message(Message.SubmittedReply()),
    model((model) => expect(model.reply).toBe("")),
    Command.resolve(
      BoardClient.PostMessage,
      BoardClient.Message.SucceededPostMessage({ commandId: "s:0", ...receipt("Thread/t-1") }),
    ),
    message(
      Message.ReceivedLine({
        threadId: t1,
        line: { seq: 2, at: 0, kind: "message", author: fixer, text: "Working on it." },
      }),
    ),
    model((model) => {
      expect(model.timeline.map((line) => line.text)).toEqual(["Working on it."]);
      expect(model.timelineCursor).toEqual(Option.some(2));
    }),
  ));

test("a line from a thread that was closed is dropped", () => {
  const other = update(
    update(signedIn, Message.ClickedThread({ threadId: t1 })).model,
    Message.ClickedThread({ threadId: ThreadId.make("t-2") }),
  ).model;
  const late = update(
    other,
    Message.ReceivedLine({
      threadId: t1,
      line: { seq: 1, at: 0, kind: "started", author: fixer, text: "late" },
    }),
  ).model;
  expect(late.timeline).toEqual([]);
  expect(late.timelineCursor).toEqual(Option.none());
});

test("switching channel clears the board and the open thread", () => {
  const opened = update(
    modifyFields(signedIn, { threads: () => ({ [t1]: ready }) }),
    Message.ClickedThread({ threadId: t1 }),
  ).model;
  const typed = update(opened, Message.ChangedChannel({ value: "security" })).model;
  const switched = update(typed, Message.SubmittedChannel()).model;
  expect(switched).toMatchObject({
    channel: "security",
    threads: {},
    boardState: "Loading",
    selected: Option.none(),
  });
});

test("labels are split on commas and spaces", () =>
  expect(parseLabels(" kind=bug,pr=812  area=checkout ")).toEqual([
    "kind=bug",
    "pr=812",
    "area=checkout",
  ]));
