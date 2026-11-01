import { describe, expect } from "bun:test";
import * as Stackit from "@alchemy.run/stackit";
import * as Test from "@alchemy.run/test/Bun";
import * as modelServing from "@distilled.cloud/stackit/model_serving";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Stackit.providers(),
  state: Alchemy.localState(),
  profile: process.env.ALCHEMY_PROFILE,
});

// Out-of-band calls resolve the same profile the deploy uses.
const StackitCloud = Layer.mergeAll(Stackit.StackitAuth, Stackit.fromAuthProvider()).pipe(
  Layer.provideMerge(FetchHttpClient.layer),
);

/** A POST that has to answer `status`, retried while a fresh function and its token settle. */
const post = (url: string, body: unknown, status: number) =>
  HttpClient.execute(HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe(body))).pipe(
    Effect.timeout("60 seconds"),
    Effect.flatMap((response) =>
      response.status === status
        ? Effect.succeed(response)
        : Effect.fail(`HTTP ${response.status}`),
    ),
    Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
  );

describe("stackit-ai", () => {
  const stack = beforeAll(deploy(Stack), { timeout: 1_200_000 });

  afterAll.skipIf(!!process.env.NO_DESTROY)(
    Effect.gen(function* () {
      const deployed = yield* stack;
      yield* destroy(Stack);

      // A failed deploy returns nothing, but the destroy above still removes what it made.
      if (deployed === undefined) return;
      const { projectId, region, tokenId } = deployed;

      const token = yield* modelServing
        .getToken({ projectId, regionId: region, tId: tokenId })
        .pipe(
          Effect.map(({ token }) => (token.state === "deleting" ? "gone" : "found")),
          Effect.catchTag("NotFound", () => Effect.succeed("gone")),
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: (state) => state === "gone",
            times: 24,
          }),
          Effect.provide(StackitCloud),
        );
      expect(token).toEqual("gone");
    }),
    { timeout: 900_000 },
  );

  test(
    "rejects a request with no prompt",
    Effect.gen(function* () {
      const { url } = yield* stack;
      yield* post(`${url}/chat`, {}, 400);
    }),
    { timeout: 300_000 },
  );

  test(
    "a prompt gets a reply from the model",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const response = yield* post(
        `${url}/chat`,
        { prompt: "Reply with the single word: ok" },
        200,
      );
      const body = (yield* response.json) as { text?: string; usage?: unknown };
      expect(body.text).toBeTruthy();
      expect(body.usage).toBeDefined();
    }),
    { timeout: 300_000 },
  );

  test(
    "the token is active",
    Effect.gen(function* () {
      const { projectId, region, tokenId } = yield* stack;
      const { token } = yield* modelServing
        .getToken({ projectId, regionId: region, tId: tokenId })
        .pipe(Effect.provide(StackitCloud));
      expect(token.state).toEqual("active");
    }),
    { timeout: 120_000 },
  );
});
