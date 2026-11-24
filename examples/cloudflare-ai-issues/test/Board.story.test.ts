import { expect, test } from "@effect/vitest";
import * as Option from "effect/Option";
import { Command, given, message, model, story } from "foldkit/story";
import { IssueId } from "../src/Board/Issue.id.ts";
import { replied, started } from "../src/Board/Said.ts";
import {
  BoardClient,
  init,
  listOf,
  Message,
  Remember,
  sendingOf,
  ShowAddress,
  threadOf,
  update,
} from "../web/src/Board.ts";
import { issueIn, urlOf } from "../web/src/Location.ts";
import { rowsOf } from "../web/src/View.ts";

const fresh = init({ issueId: Option.none(), page: "p", issues: [] }).model;
const mine = IssueId.make("p-0");
const receipt = { stream: "Issue/p-0", version: 1 };
const shown = Command.resolve(ShowAddress, Message.CompletedShowAddress());
const remembered = Command.resolve(Remember, Message.CompletedRemember());
const user = (seq: number, text: string) => ({ seq, item: { type: "user" as const, text } });
const listed = (issueId: IssueId, title: string) => ({
  issueId,
  title,
  label: null,
  replies: 0,
  working: false,
});

test("a new issue is on screen before the board answers", () =>
  story(
    update,
    given(fresh),
    message(Message.ChangedTitle({ text: "  Export does nothing " })),
    message(Message.ChangedBody({ text: "No file, no error." })),
    message(Message.SubmittedIssue()),
    // Nothing has come back yet: the page already shows all of it.
    model((model) => {
      expect(model.selected).toEqual(Option.some(mine));
      expect(threadOf(model).detail).toEqual(
        Option.some({ title: "Export does nothing", body: "No file, no error.", label: null }),
      );
      expect(threadOf(model).status).toBe("working");
      expect(listOf(model)).toEqual([
        { ...listed(mine, "Export does nothing"), working: true, sending: true },
      ]);
      expect(model.title).toBe("");
    }),
    Command.resolve(
      BoardClient.ReportIssue,
      BoardClient.Message.SucceededReportIssue({
        commandId: "p:0",
        reply: undefined,
        receipt,
        commits: [receipt],
      }),
    ),
    shown,
    // The board lists it: its own copy takes the place of the page's.
    message(Message.ReceivedIssues({ issues: [listed(mine, "Export does nothing")] })),
    remembered,
    model((model) => {
      expect(listOf(model).map((issue) => issue.sending)).toEqual([false]);
      // Its agent is still starting, though the list does not say so yet.
      expect(listOf(model)[0]?.working).toBe(true);
      expect(threadOf(model).status).toBe("working");
    }),
    // The agent has it: from here the board's own status is what shows.
    message(Message.ReceivedItem({ issueId: mine, entry: user(1, started(mine)), cursor: 1 })),
    model((model) => {
      expect(model.pending).toEqual([]);
    }),
  ));

test("an issue the board refuses is taken back, and its words return to the form", () =>
  story(
    update,
    given(fresh),
    message(Message.ChangedTitle({ text: "Export does nothing" })),
    message(Message.SubmittedIssue()),
    Command.resolve(
      BoardClient.ReportIssue,
      BoardClient.Message.FailedReportIssue({ commandId: "p:0", failure: { _tag: "Unknown" } }),
    ),
    shown,
    model((model) => {
      expect(model.selected).toEqual(Option.none());
      expect(listOf(model)).toEqual([]);
      expect(model.title).toBe("Export does nothing");
      expect(Option.isSome(model.error)).toBe(true);
    }),
  ));

const first = IssueId.make("1");
const second = IssueId.make("2");
const board = { ...fresh, issues: [listed(first, "First"), listed(second, "Second")] };

test("a reply is on screen at once, and gives way to the board's copy", () =>
  story(
    update,
    given(board),
    message(Message.ClickedIssue({ issueId: first })),
    shown,
    message(Message.ChangedReply({ text: "Any update?" })),
    message(Message.SubmittedReply()),
    model((model) => {
      expect(sendingOf(model).map((pending) => pending.text)).toEqual(["Any update?"]);
      expect(threadOf(model).status).toBe("working");
      expect(model.reply).toBe("");
    }),
    Command.resolve(
      BoardClient.CommentOnIssue,
      BoardClient.Message.SucceededCommentOnIssue({
        commandId: "p:0",
        reply: undefined,
        receipt,
        commits: [receipt],
      }),
    ),
    // An idle status that was already on its way does not hide that the agent is about to work.
    message(Message.ReceivedStatus({ issueId: first, status: "idle", queued: [] })),
    model((model) => {
      expect(threadOf(model).status).toBe("working");
    }),
    message(
      Message.ReceivedItem({ issueId: first, entry: user(3, replied("Any update?")), cursor: 1 }),
    ),
    // The agent has it. From here the board's own status is what shows.
    model((model) => {
      expect(sendingOf(model)).toEqual([]);
      expect(model.pending).toEqual([]);
      expect(threadOf(model).status).toBe("idle");
      expect(rowsOf(threadOf(model).items)).toEqual([
        { kind: "user", seq: 3, text: "Any update?" },
      ]);
    }),
  ));

test("a reply the board refuses goes back in the box", () =>
  story(
    update,
    given({ ...board, selected: Option.some(first), reply: "Any update?" }),
    message(Message.SubmittedReply()),
    Command.resolve(
      BoardClient.CommentOnIssue,
      BoardClient.Message.FailedCommentOnIssue({ commandId: "p:0", failure: { _tag: "Unknown" } }),
    ),
    model((model) => {
      expect(sendingOf(model)).toEqual([]);
      expect(model.reply).toBe("Any update?");
      expect(Option.isSome(model.error)).toBe(true);
    }),
  ));

test("opening an issue shows what the page knows of it at once", () =>
  story(
    update,
    given(board),
    message(Message.ClickedIssue({ issueId: first })),
    shown,
    // From the list alone, before any read answers.
    model((model) => {
      expect(Option.map(threadOf(model).detail, (detail) => detail.title)).toEqual(
        Option.some("First"),
      );
    }),
    message(Message.ReceivedItem({ issueId: first, entry: user(2, replied("hello")), cursor: 1 })),
    message(Message.ClickedIssue({ issueId: second })),
    shown,
    // An entry of the first issue that was on its way is filed under the first.
    message(Message.ReceivedItem({ issueId: first, entry: user(4, replied("late")), cursor: 2 })),
    model((model) => {
      expect(threadOf(model).items).toEqual([]);
    }),
    // Coming back is instant: its transcript was kept, and resumes where it stopped.
    message(Message.ClickedIssue({ issueId: first })),
    shown,
    model((model) => {
      expect(threadOf(model).items.map((entry) => entry.seq)).toEqual([2, 4]);
      expect(threadOf(model).cursor).toEqual(Option.some(2));
    }),
  ));

test("the list of the last visit is shown until the board answers", () => {
  const { model } = init({
    issueId: Option.some(first),
    page: "p",
    issues: [listed(first, "First")],
  });
  expect(model.listed).toBe(false);
  expect(listOf(model).map((issue) => issue.title)).toEqual(["First"]);
  expect(Option.map(threadOf(model).detail, (detail) => detail.title)).toEqual(
    Option.some("First"),
  );
});

test("the address names the open issue, so a refresh opens it again", () => {
  const address = urlOf("https://board.example/", Option.some(first));
  expect(address).toBe("https://board.example/?issue=1");
  expect(issueIn(address)).toEqual(Option.some(first));
  expect(issueIn(urlOf(address, Option.none()))).toEqual(Option.none());
});

test("the thread joins each tool call with its result, and leaves out what started the agent", () => {
  const rows = rowsOf([
    user(1, started("1")),
    {
      seq: 2,
      item: {
        type: "assistant",
        text: "",
        toolCalls: [
          { id: "a", name: "grep", input: { pattern: "export" } },
          { id: "b", name: "Board_LabelIssue_send", input: {} },
        ],
      },
    },
    { seq: 3, item: { type: "tool", callId: "a", name: "grep", output: "none", isError: false } },
    { seq: 4, item: { type: "assistant", text: "Labeled bug.", toolCalls: [] } },
  ]);
  expect(rows.map((row) => row.kind)).toEqual(["step", "step", "agent"]);
  expect(rows[0]).toMatchObject({
    name: "grep",
    output: Option.some({ text: "none", isError: false }),
  });
  // Still running: it has no result yet.
  expect(rows[1]).toMatchObject({ name: "Board_LabelIssue_send", output: Option.none() });
});
