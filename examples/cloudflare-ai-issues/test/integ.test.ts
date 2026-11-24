// Runs under `bun test`: deploys the whole example and drives its web page.
import { expect } from "bun:test";
import * as Boat from "@alchemy.run/boat";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Domain from "@alchemy.run/domain";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import * as GitHub from "@alchemy.run/github";
import * as Test from "@alchemy.run/test/Bun";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Socket from "effect/socket/Socket";
import Stack from "../alchemy.run.ts";
import { started } from "../src/Board/Said.ts";
import { WebApi } from "../src/Board/WebApi.api.ts";
import { Message, threadOf } from "../web/src/Board.ts";
import { open } from "./App.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.mergeAll(
    Cloudflare.providers(),
    DomainCloudflare.providers(),
    Boat.providers(),
    GitHub.providers(),
  ),
  state: Alchemy.localState(),
});

const stack = beforeAll(deploy(Stack), { timeout: 600_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

/** The page's own connection, as `web/src/entry.ts` makes it, on the app's origin. */
const connection = (app: string) =>
  WebApi.layerClient.pipe(
    Layer.provide(Domain.protocolWebSocket(`${app}/api`)),
    Layer.provide(Layer.mergeAll(FetchHttpClient.layer, Socket.layerWebSocketConstructorGlobal)),
  );

test(
  "the app's Worker serves the page and its script",
  Effect.gen(function* () {
    const { app } = yield* stack;
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    const html = yield* client.get(`${app}/`).pipe(
      Effect.flatMap((response) => response.text),
      Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 8 }),
    );
    expect(html).toContain('<div id="root">');
    const script = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
    expect(script).toBeDefined();
    const style = /href="(\/assets\/[^"]+\.css)"/.exec(html)?.[1];
    expect(style).toBeDefined();
    expect(yield* client.get(`${app}${style}`).pipe(Effect.flatMap((r) => r.text))).toContain(
      ".sidebar",
    );
    const code = yield* client.get(`${app}${script}`).pipe(Effect.flatMap((r) => r.text));
    // The build is the page: it names the reads and the commands it uses.
    for (const name of [
      "IssueList",
      "SessionStatus",
      "Transcript",
      "ReportIssue",
      "CommentOnIssue",
    ]) {
      expect(code).toContain(name);
    }
  }).pipe(Effect.provide(FetchHttpClient.layer)),
  { timeout: 120_000 },
);

test(
  "the page reports an issue, follows the real agent, replies, and resumes after a refresh",
  Effect.gen(function* () {
    const { app } = yield* stack;
    const seen = yield* Effect.gen(function* () {
      const page = yield* open({ issues: [], issueId: Option.none(), page: `integ-${Date.now()}` });
      const empty = yield* page.until((model) => model.listed);
      expect(empty.error).toEqual(Option.none());

      yield* page.dispatch(Message.ChangedTitle({ text: "The export button does nothing" }));
      yield* page.dispatch(Message.SubmittedIssue());

      // Shown at once, before the board answers.
      const working = yield* page.until((model) => threadOf(model).status === "working");
      const issueId = Option.getOrThrow(working.selected);
      expect(Option.map(threadOf(working).detail, (detail) => detail.title)).toEqual(
        Option.some("The export button does nothing"),
      );
      // The sidebar shows it, with its agent at work.
      yield* page.until((model) =>
        model.issues.some((issue) => issue.issueId === issueId && issue.working),
      );

      const done = yield* page.until(
        (model) =>
          threadOf(model).status === "idle" &&
          threadOf(model).items.length > 2 &&
          Option.exists(threadOf(model).detail, (detail) => detail.label !== null),
      );

      // A reply goes to the same agent, and the page sees what it did with it.
      yield* page.dispatch(
        Message.ChangedReply({ text: "On reflection this is a question. Label it question." }),
      );
      yield* page.dispatch(Message.SubmittedReply());
      // The agent takes the reply up, then finishes with it.
      yield* page.until((model) => model.pending.length === 0);
      const replied = yield* page.until(
        (model) =>
          threadOf(model).status === "idle" &&
          Option.exists(threadOf(model).detail, (detail) => detail.label === "question"),
      );

      // A refresh: a new page load with the issue in its address reads it all back.
      const refreshed = yield* open({
        issues: [],
        issueId: Option.some(issueId),
        page: "integ-refresh",
      });
      const resumed = yield* refreshed.until(
        (model) =>
          threadOf(model).caughtUp && model.listed && Option.isSome(threadOf(model).detail),
      );
      // The status and the transcript are two reads: the first page may see
      // `idle` a moment before the last item. Both pages end with the same items.
      const settled = yield* page.until(
        (model) => threadOf(model).items.length >= threadOf(resumed).items.length,
      );
      return { issueId, done, replied: settled, resumed };
    }).pipe(Effect.scoped, Effect.provide(connection(app)));

    expect(threadOf(seen.done).items[0]?.item).toEqual({
      type: "user",
      text: started(seen.issueId),
    });
    expect(JSON.stringify(threadOf(seen.done).items)).toContain("Board_LabelIssue_send");
    // Every item once, in order.
    const seqs = threadOf(seen.replied).items.map((entry) => entry.seq);
    expect(seqs).toEqual([...new Set(seqs)].sort((a, b) => a - b));
    expect(threadOf(seen.replied).items.length).toBeGreaterThan(threadOf(seen.done).items.length);
    expect(seen.replied.error).toEqual(Option.none());
    // The refreshed page has the same transcript and finds the issue in the list.
    expect(threadOf(seen.resumed).items).toEqual(threadOf(seen.replied).items);
    expect(seen.resumed.issues.find((issue) => issue.issueId === seen.issueId)).toMatchObject({
      title: "The export button does nothing",
      label: "question",
      replies: 1,
    });
  }),
  { timeout: 300_000 },
);
