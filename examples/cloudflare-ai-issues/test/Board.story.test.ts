import { expect, test } from "@effect/vitest";
import * as Option from "effect/Option";
import { Command, given, message, model, story } from "foldkit/story";
import { IssueId } from "../src/Board/Issue.id.ts";
import { BoardClient, init, Message, ShowAddress, update } from "../web/src/Board.ts";
import { issueIn, urlOf } from "../web/src/Location.ts";
import { rowsOf } from "../web/src/View.ts";

const fresh = init({ issueId: Option.none(), page: "p" }).model;
const receipt = { stream: "Issue/p-0", version: 1 };
const shown = Command.resolve(ShowAddress, Message.CompletedShowAddress());
const reported = Command.resolve(
  BoardClient.ReportIssue,
  BoardClient.Message.SucceededReportIssue({
    commandId: "p:0",
    reply: undefined,
    receipt,
    commits: [receipt],
  }),
);

test("reporting an issue names it, opens it and puts it in the address", () =>
  story(
    update,
    given(fresh),
    message(Message.ChangedTitle({ text: "  Export does nothing " })),
    message(Message.ChangedBody({ text: "No file, no error." })),
    message(Message.SubmittedIssue()),
    reported,
    shown,
    model((model) => {
      expect(model.selected).toEqual(Option.some(IssueId.make("p-0")));
      expect(model.title).toBe("");
      expect(model.body).toBe("");
      expect(model.commandIds.sent).toBe(1);
    }),
  ));

test("an issue with no title is not reported", () =>
  story(
    update,
    given(fresh),
    message(Message.ChangedTitle({ text: "   " })),
    message(Message.SubmittedIssue()),
    model((model) => {
      expect(model.selected).toEqual(Option.none());
      expect(model.commandIds.sent).toBe(0);
    }),
  ));

const first = IssueId.make("1");
const second = IssueId.make("2");
const item = (seq: number, text: string) => ({ seq, item: { type: "user" as const, text } });

test("opening another issue drops what was read of the last one", () =>
  story(
    update,
    given(fresh),
    message(Message.ClickedIssue({ issueId: first })),
    shown,
    message(Message.ReceivedStatus({ status: "working", queued: [] })),
    message(Message.ReceivedItem({ issueId: first, entry: item(9, "The issue is 1."), cursor: 1 })),
    model((model) => {
      expect(model.items).toHaveLength(1);
      expect(model.cursor).toEqual(Option.some(1));
    }),
    message(Message.ClickedIssue({ issueId: second })),
    shown,
    model((model) => {
      expect(model.selected).toEqual(Option.some(second));
      expect(model.items).toEqual([]);
      expect(model.cursor).toEqual(Option.none());
      expect(model.status).toBe("idle");
    }),
    // An entry of the first issue that was already on its way is not the second's.
    message(Message.ReceivedItem({ issueId: first, entry: item(11, "late"), cursor: 2 })),
    model((model) => {
      expect(model.items).toEqual([]);
    }),
  ));

test("back and forward open the issue their address names", () =>
  story(
    update,
    given({ ...fresh, selected: Option.some(first) }),
    message(Message.ChangedAddress({ issueId: Option.none() })),
    model((model) => {
      expect(model.selected).toEqual(Option.none());
    }),
  ));

test("a reply is a CommentOnIssue on the open issue, and a refusal is shown", () =>
  story(
    update,
    given({ ...fresh, selected: Option.some(first), reply: "Any update?" }),
    message(Message.SubmittedReply()),
    Command.resolve(
      BoardClient.CommentOnIssue,
      BoardClient.Message.FailedCommentOnIssue({
        commandId: "p:0",
        failure: { _tag: "Unknown" },
      }),
    ),
    model((model) => {
      expect(model.reply).toBe("");
      expect(model.error).toEqual(Option.some("The board did not answer. Try again."));
    }),
  ));

test("the address names the open issue, so a refresh opens it again", () => {
  const address = urlOf("https://board.example/", Option.some(first));
  expect(address).toBe("https://board.example/?issue=1");
  expect(issueIn(address)).toEqual(Option.some(first));
  expect(issueIn(urlOf(address, Option.none()))).toEqual(Option.none());
});

test("the thread joins each tool call with its result", () => {
  const rows = rowsOf([
    item(1, "The issue is 1."),
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
  expect(rows.map((row) => row.kind)).toEqual(["user", "step", "step", "agent"]);
  expect(rows[1]).toMatchObject({
    name: "grep",
    output: Option.some({ text: "none", isError: false }),
  });
  // Still running: it has no result yet.
  expect(rows[2]).toMatchObject({ name: "Board_LabelIssue_send", output: Option.none() });
});
