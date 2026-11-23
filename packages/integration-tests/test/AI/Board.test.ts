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
