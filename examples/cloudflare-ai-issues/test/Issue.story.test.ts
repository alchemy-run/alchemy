import { expect, test } from "@effect/vitest";
import * as Option from "effect/Option";
import { Command, given, message, model, story } from "foldkit/story";
import { IssueId } from "../src/Board/Issue.id.ts";
import { BoardClient, init, Message, update } from "../web/src/Issue.ts";
import { issueOf } from "../web/src/Location.ts";

const issueId = IssueId.make("42");
const fresh = init({ issueId, page: "p" }).model;
const receipt = { stream: "Issue/42", version: 1 };

test("reporting sends ReportIssue with the draft as its title", () =>
  story(
    update,
    given(fresh),
    message(Message.ChangedDraft({ text: "Export does nothing" })),
    message(Message.ClickedReport()),
    Command.resolve(
      BoardClient.ReportIssue,
      BoardClient.Message.SucceededReportIssue({
        commandId: "p:0",
        reply: undefined,
        receipt,
        commits: [receipt],
      }),
    ),
    model((model) => {
      expect(model.draft).toBe("");
      expect(model.commandIds.sent).toBe(1);
      expect(model.error).toEqual(Option.none());
    }),
  ));

test("the agent's status, queue and transcript come from the board's reads", () =>
  story(
    update,
    given(fresh),
    message(Message.ReceivedIssue({ title: Option.some("Export"), label: Option.none() })),
    message(
      Message.ReceivedStatus({
        status: "working",
        queued: [{ id: "7", text: "And the import?", delivery: "queue" }],
      }),
    ),
    message(
      Message.ReceivedItem({
        entry: { seq: 9, item: { type: "user", text: "The issue is 42." } },
        cursor: 1,
      }),
    ),
    model((model) => {
      expect(model.title).toEqual(Option.some("Export"));
      expect(model.status).toBe("working");
      expect(model.queued.map((queued) => queued.text)).toEqual(["And the import?"]);
      expect(model.items.map((entry) => entry.seq)).toEqual([9]);
      // The next read resumes after this entry.
      expect(model.cursor).toEqual(Option.some(1));
    }),
    message(Message.ReceivedStatus({ status: "idle", queued: [] })),
    message(Message.ReceivedIssue({ title: Option.some("Export"), label: Option.some("bug") })),
    model((model) => {
      expect(model.status).toBe("idle");
      expect(model.label).toEqual(Option.some("bug"));
    }),
  ));

test("a reply is a CommentOnIssue, and a refusal is shown", () =>
  story(
    update,
    given({ ...fresh, draft: "Any update?" }),
    message(Message.ClickedReply()),
    Command.resolve(
      BoardClient.CommentOnIssue,
      BoardClient.Message.FailedCommentOnIssue({
        commandId: "p:0",
        failure: { _tag: "Unknown" },
      }),
    ),
    model((model) => {
      expect(model.error).toEqual(Option.some("Unknown"));
    }),
  ));

test("a failed read is shown and does not lose what the page has", () =>
  story(
    update,
    given({ ...fresh, items: [{ seq: 9, item: { type: "user", text: "The issue is 42." } }] }),
    message(Message.FailedRead({ reason: "RpcClientError" })),
    model((model) => {
      expect(model.error).toEqual(Option.some("RpcClientError"));
      expect(model.items).toHaveLength(1);
    }),
  ));

test("a URL that names no issue is given one, and then keeps it across a refresh", () => {
  const first = issueOf("https://board.example/", () => "web-1");
  expect(first).toEqual({ issueId: "web-1", url: "https://board.example/?issue=web-1" });
  // The refresh loads the URL the first load left in the address bar.
  const refreshed = issueOf(first.url, () => "web-2");
  expect(refreshed).toEqual(first);
});
