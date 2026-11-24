import type { SessionEntry } from "@alchemy.run/ai/Session";
import * as Option from "effect/Option";
import type { Document, Html, HtmlBuilder } from "foldkit/html";
import { type Listed, Message, type Model } from "./Board.ts";

type H = HtmlBuilder<Message>;

/** A tool's name as a person reads it: `Board_LabelIssue_send` is "Label issue". */
const toolName = (name: string) => {
  const words = name
    .replace(/^Board_/, "")
    .replace(/_(send|get|list|ask)$/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const short = (text: string, length: number) =>
  text.length > length ? `${text.slice(0, length)}…` : text;

const pretty = (value: unknown) => {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  try {
    return typeof value === "string" ? JSON.stringify(JSON.parse(text), null, 2) : text;
  } catch {
    return text;
  }
};

/** One step of the agent: a tool it called, with what the tool answered once it has. */
interface Step {
  readonly seq: number;
  readonly name: string;
  readonly input: unknown;
  readonly output: Option.Option<{ readonly text: string; readonly isError: boolean }>;
}

/** The transcript as a thread: messages, and each tool call joined with its result. */
type Row =
  | { readonly kind: "user" | "agent"; readonly seq: number; readonly text: string }
  | ({ readonly kind: "step" } & Step);

export const rowsOf = (items: ReadonlyArray<SessionEntry>): ReadonlyArray<Row> => {
  const results = new Map(
    items.flatMap(({ item }) =>
      item.type === "tool" ? [[item.callId, { text: item.output, isError: item.isError }]] : [],
    ),
  );
  return items.flatMap(({ seq, item }): ReadonlyArray<Row> => {
    if (item.type === "user") return [{ kind: "user", seq, text: item.text }];
    if (item.type === "tool") return [];
    return [
      ...(item.text.trim() === "" ? [] : [{ kind: "agent" as const, seq, text: item.text }]),
      ...item.toolCalls.map((call, index) => ({
        kind: "step" as const,
        seq: seq * 100 + index,
        name: call.name,
        input: call.input,
        output: Option.fromNullishOr(results.get(call.id)),
      })),
    ];
  });
};

const labelView = (label: Listed["label"], h: H) =>
  label === null
    ? h.span([h.Class("label none")], ["unlabeled"])
    : h.span([h.Class(`label ${label}`)], [label]);

const listedView = (issue: Listed, model: Model, h: H) =>
  h.keyed("li")(
    issue.issueId,
    [],
    [
      h.button(
        [
          h.Class(Option.contains(model.selected, issue.issueId) ? "issue selected" : "issue"),
          h.OnClick(Message.ClickedIssue({ issueId: issue.issueId })),
        ],
        [
          h.span([h.Class("issue-title")], [issue.title]),
          h.span(
            [h.Class("issue-meta")],
            [
              labelView(issue.label, h),
              ...(issue.working ? [h.span([h.Class("dot working")], ["working"])] : []),
              ...(issue.replies > 0
                ? [
                    h.span(
                      [h.Class("replies")],
                      [`${issue.replies} ${issue.replies === 1 ? "reply" : "replies"}`],
                    ),
                  ]
                : []),
            ],
          ),
        ],
      ),
    ],
  );

const sidebar = (model: Model, h: H) =>
  h.aside(
    [h.Class("sidebar")],
    [
      h.header(
        [h.Class("sidebar-head")],
        [
          h.h1([], ["Issue board"]),
          h.button([h.Class("primary"), h.OnClick(Message.ClickedNewIssue())], ["New issue"]),
        ],
      ),
      model.issues.length === 0
        ? h.p(
            [h.Class("empty")],
            [model.listed ? "No issues yet. Report the first one." : "Loading issues…"],
          )
        : h.ul(
            [h.Class("issues")],
            model.issues.map((issue) => listedView(issue, model, h)),
          ),
    ],
  );

const newIssue = (model: Model, h: H) =>
  h.section(
    [h.Class("panel")],
    [
      h.form(
        [h.Class("new-issue"), h.OnSubmit(Message.SubmittedIssue())],
        [
          h.h2([], ["Report an issue"]),
          h.p(
            [h.Class("hint")],
            [
              "An agent reads it, looks through the code, answers and labels it. You can watch it work.",
            ],
          ),
          h.input([
            h.Value(model.title),
            h.Placeholder("Title"),
            h.AriaLabel("Title"),
            h.OnInput((text) => Message.ChangedTitle({ text })),
          ]),
          h.textarea([
            h.Value(model.body),
            h.Placeholder("What happened? (optional)"),
            h.AriaLabel("Description"),
            h.Rows(6),
            h.OnInput((text) => Message.ChangedBody({ text })),
          ]),
          h.button([h.Class("primary"), h.Type("submit")], ["Report issue"]),
        ],
      ),
    ],
  );

const stepView = (step: Step, h: H) =>
  h.keyed("li")(
    `step-${step.seq}`,
    [h.Class("row step")],
    [
      h.details(
        [],
        [
          h.summary(
            [],
            [
              h.span(
                [
                  h.Class(
                    Option.match(step.output, {
                      onNone: () => "dot working",
                      onSome: (output) => (output.isError ? "dot failed" : "dot done"),
                    }),
                  ),
                ],
                [],
              ),
              h.span([h.Class("step-name")], [toolName(step.name)]),
              h.span(
                [h.Class("step-result")],
                [
                  Option.match(step.output, {
                    onNone: () => "running…",
                    onSome: (output) => short(output.text.replace(/\s+/g, " "), 90),
                  }),
                ],
              ),
            ],
          ),
          h.pre([], [pretty(step.input)]),
          ...Option.match(step.output, {
            onNone: () => [],
            onSome: (output) => [h.pre([], [pretty(output.text)])],
          }),
        ],
      ),
    ],
  );

const rowView = (row: Row, h: H): Html =>
  row.kind === "step"
    ? stepView(row, h)
    : h.keyed("li")(
        `message-${row.seq}`,
        [h.Class(`row ${row.kind}`)],
        [
          h.span([h.Class("who")], [row.kind === "user" ? "To the agent" : "Agent"]),
          h.div([h.Class("bubble")], [row.text]),
        ],
      );

const thread = (model: Model, h: H) => {
  const title = Option.match(model.detail, {
    onNone: () => "Opening…",
    onSome: (detail) => detail.title,
  });
  const rows = rowsOf(model.items);
  return h.section(
    [h.Class("panel thread")],
    [
      h.header(
        [h.Class("thread-head")],
        [
          h.h2([], [title]),
          h.div(
            [h.Class("issue-meta")],
            [
              labelView(Option.getOrNull(Option.map(model.detail, (detail) => detail.label)), h),
              h.span(
                [h.Class(model.status === "working" ? "dot working" : "dot idle")],
                [model.status === "working" ? "Agent is working" : "Agent is idle"],
              ),
            ],
          ),
          ...Option.match(
            Option.filter(model.detail, (detail) => detail.body !== ""),
            { onNone: () => [], onSome: (detail) => [h.p([h.Class("body")], [detail.body])] },
          ),
        ],
      ),
      h.ul(
        [h.Class("rows")],
        [
          ...rows.map((row) => rowView(row, h)),
          ...model.queued.map((message) =>
            h.keyed("li")(
              `queued-${message.id}`,
              [h.Class("row user queued")],
              [
                h.span([h.Class("who")], ["Queued until the agent is free"]),
                h.div([h.Class("bubble")], [message.text]),
              ],
            ),
          ),
          ...(rows.length === 0 && model.caughtUp
            ? [h.keyed("li")("empty", [h.Class("empty")], ["The agent has not started yet."])]
            : []),
        ],
      ),
      h.form(
        [h.Class("composer"), h.OnSubmit(Message.SubmittedReply())],
        [
          h.input([
            h.Value(model.reply),
            h.Placeholder(
              model.status === "working"
                ? "Reply. It is queued until the agent is free."
                : "Reply to the agent",
            ),
            h.AriaLabel("Reply"),
            h.OnInput((text) => Message.ChangedReply({ text })),
          ]),
          h.button([h.Class("primary"), h.Type("submit")], ["Send"]),
        ],
      ),
    ],
  );
};

export const view = (model: Model, h: H): Document => ({
  title: Option.match(model.detail, {
    onNone: () => "Issue board",
    onSome: (detail) => `${detail.title} · Issue board`,
  }),
  body: h.div(
    [h.Class("board")],
    [
      sidebar(model, h),
      h.main(
        [h.Class("main")],
        [
          ...Option.match(model.error, {
            onNone: () => [],
            onSome: (error) => [h.p([h.Class("error")], [error])],
          }),
          Option.isSome(model.selected) ? thread(model, h) : newIssue(model, h),
        ],
      ),
    ],
  ),
});
