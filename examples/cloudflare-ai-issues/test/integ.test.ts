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
import { IssueId } from "../src/Board/Issue.id.ts";
import { WebApi } from "../src/Board/WebApi.api.ts";
import { Message } from "../web/src/Issue.ts";
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
    const code = yield* client.get(`${app}${script}`).pipe(Effect.flatMap((r) => r.text));
    // The build is the page: it names the reads and the commands it uses.
    for (const name of ["SessionStatus", "Transcript", "ReportIssue", "CommentOnIssue"]) {
      expect(code).toContain(name);
    }
  }).pipe(Effect.provide(FetchHttpClient.layer)),
  { timeout: 120_000 },
);

test(
  "the page reports an issue and follows the real agent until it has labeled it",
  Effect.gen(function* () {
    const { app } = yield* stack;
    const issueId = IssueId.make(`integ-${Date.now()}`);
    const seen = yield* Effect.gen(function* () {
      const page = yield* open({ issueId, page: "integ" });
      // The page has loaded: every read answered, and nothing is reported yet.
      const empty = yield* page.until((model) => Option.isSome(model.cursor));
      expect(empty.title).toEqual(Option.none());
      expect(empty.error).toEqual(Option.none());

      yield* page.dispatch(Message.ChangedDraft({ text: "The export button does nothing" }));
      yield* page.dispatch(Message.ClickedReport());

      const working = yield* page.until((model) => model.status === "working");
      expect(working.title).toEqual(Option.some("The export button does nothing"));

      const done = yield* page.until(
        (model) => model.status === "idle" && Option.isSome(model.label) && model.items.length > 2,
      );

      // A reply goes to the same session, and the page sees what it did with it.
      yield* page.dispatch(
        Message.ChangedDraft({ text: "On reflection this is a question. Label it question." }),
      );
      yield* page.dispatch(Message.ClickedReply());
      const replied = yield* page.until(
        (model) => model.status === "idle" && Option.contains(model.label, "question"),
      );
      return { done, replied };
    }).pipe(Effect.scoped, Effect.provide(connection(app)));

    expect(seen.done.items[0]?.item).toEqual({ type: "user", text: `The issue is ${issueId}.` });
    expect(JSON.stringify(seen.done.items)).toContain("Board_LabelIssue_send");
    // Every item once, in order.
    const seqs = seen.replied.items.map((entry) => entry.seq);
    expect(seqs).toEqual([...new Set(seqs)].sort((a, b) => a - b));
    expect(seen.replied.items.length).toBeGreaterThan(seen.done.items.length);
    expect(seen.replied.error).toEqual(Option.none());
  }),
  { timeout: 300_000 },
);
