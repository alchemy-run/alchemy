import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import BoardWorker from "./fixtures/board/BoardWorker.ts";
import { IssueId } from "./fixtures/board/Issue.id.ts";

const providers = Layer.mergeAll(Cloudflare.providers(), DomainCloudflare.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers });

const Stack = Alchemy.Stack(
  "ProcessBoardStack",
  { providers, state: Cloudflare.state() },
  Effect.gen(function* () {
    const board = yield* BoardWorker;
    return { url: board.url.as<string>() };
  }),
);

const stack = beforeAll(deploy(Stack), { timeout: 300_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const tags = ["provider:cloudflare", "provider:pi", "live"];

interface Detail {
  readonly title: string;
  readonly label: "bug" | "feature" | "question" | null;
  readonly labeledBy: string | null;
  readonly comments: ReadonlyArray<string>;
}

/** Call the board, retrying while the fresh Worker starts serving. */
const call = Effect.fn(function* (path: string, body: object = {}) {
  const { url } = yield* stack;
  const client = yield* HttpClient.HttpClient;
  const response = yield* HttpClient.filterStatusOk(client)
    .execute(HttpClientRequest.post(`${url}/${path}`).pipe(HttpClientRequest.bodyJsonUnsafe(body)))
    .pipe(
      Effect.tapError((error) =>
        error.response === undefined
          ? Effect.void
          : Effect.flatMap(error.response.text, (text) => Effect.logError(text)),
      ),
      Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 6 }),
    );
  return (yield* response.json) as Detail | null;
});

/** The issue, once the board shows `label` on it. */
const labeled = (issue: string, label: Detail["label"]) =>
  call(`issue/${issue}`).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (detail) => detail?.label === label,
      times: 30,
    }),
  );

test(
  "a reported issue is labeled by the process its policy starts",
  Effect.gen(function* () {
    const issue = "crash";
    // Nothing here names a session: the board's policy starts one for the issue.
    yield* call(`report/${issue}`, { title: "The app crashes when I open the settings page" });

    const detail = yield* labeled(issue, "bug");
    expect(detail).toMatchObject({
      title: "The app crashes when I open the settings page",
      label: "bug",
      // The label command is behind a middleware that says who is calling:
      // what the session was started as answered it.
      labeledBy: "triage-bot",
    });
  }),
  { tags, timeout: 180_000 },
);

test(
  "a comment reaches the issue's session through the policy",
  Effect.gen(function* () {
    const issue = "dark-mode";
    yield* call(`report/${issue}`, { title: "Please add a dark mode" });
    yield* labeled(issue, "feature");

    yield* call(`comment/${issue}`, {
      commentId: `${issue}-1`,
      body: "On reflection I am only asking whether one exists. Label this question.",
    });

    const detail = yield* labeled(issue, "question");
    expect(detail?.comments).toHaveLength(1);
  }),
  { tags, timeout: 240_000 },
);

test(
  "a Worker asks a session and waits for its answer",
  Effect.gen(function* () {
    // The Worker holds a client: the session runs in an object of its own.
    const asked = (yield* call("ask/greeting", {
      body: "Do not label anything. Reply with the single word ready.",
    })) as unknown as { readonly answer: string };
    expect(asked.answer.toLowerCase()).toContain("ready");
  }),
  { tags, timeout: 180_000 },
);

/** Where an issue's session stands and its transcript, read from outside its object. */
const session = (issue: string) =>
  call(`session/${issue}`) as unknown as Effect.Effect<
    {
      readonly status: "idle" | "working";
      readonly queued: ReadonlyArray<unknown>;
      readonly items: ReadonlyArray<{
        readonly seq: number;
        readonly item: { readonly type: string; readonly text?: string };
      }>;
    },
    never,
    HttpClient.HttpClient
  >;

test(
  "a caller outside a session's object reads where it stands and its transcript",
  Effect.gen(function* () {
    const issue = IssueId.make("slow-search");
    // A session nobody sent anything is idle, with nothing stored.
    expect(yield* session(issue)).toEqual({ status: "idle", queued: [], items: [] });

    yield* call(`report/${issue}`, { title: "Search takes ten seconds to answer" });
    const settled = yield* session(issue).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (read) => read.status === "idle" && read.items.length > 1,
        times: 60,
      }),
    );
    expect(settled.status).toBe("idle");
    expect(settled.items[0]?.item).toEqual({ type: "user", text: `The issue is ${issue}.` });
    // Numbered in order, with the command the session sent among them.
    const seqs = settled.items.map((entry) => entry.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(JSON.stringify(settled.items)).toContain("LabelIssue");
  }),
  { tags, timeout: 240_000 },
);

test(
  "a session carries on though its object is reset in the middle of a turn",
  Effect.gen(function* () {
    const issue = IssueId.make("lost-upload");
    yield* call(`report/${issue}`, { title: "My upload disappears after I refresh" });
    // Reset it once it is at work: everything the object held in memory is gone.
    yield* session(issue).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("200 millis"),
        until: (read) => read.status === "working",
        times: 150,
      }),
    );
    yield* call(`crash/${issue}`);
    yield* labeled(issue, "bug");

    const settled = yield* session(issue).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (read) => read.status === "idle",
        times: 30,
      }),
    );
    expect(settled.status).toBe("idle");
    expect(JSON.stringify(settled.items)).toContain("LabelIssue");
  }),
  { tags, timeout: 240_000 },
);
