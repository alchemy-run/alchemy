import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { expectUrlContains } from "../Utils/Http.ts";
import Stack from "./fixtures/do-abort/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

let bust = 0;
const getJson = <T>(
  client: HttpClient.HttpClient,
  url: string,
  phase: "before abort" | "after abort",
): Effect.Effect<T, unknown> =>
  Effect.sync(() => `${url}?cb=${Date.now()}-${bust++}`).pipe(
    Effect.flatMap((url) => client.get(url)),
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.retry({
      while: (error) => {
        if (error.reason._tag !== "StatusCodeError")
          return Effect.succeed(false);
        const response = error.reason.response;
        if (
          response.status === 404 &&
          (response.headers["content-type"] ?? "").includes("text/html")
        ) {
          return Effect.succeed(true);
        }
        // Only initial readiness honors the native RPC retry flag; abort failures remain failures.
        if (phase !== "before abort" || response.status !== 500)
          return Effect.succeed(false);
        return response.json.pipe(
          Effect.flatMap((body) => {
            const retryable =
              typeof body === "object" &&
              body !== null &&
              "retryable" in body &&
              body.retryable === true &&
              "overloaded" in body &&
              body.overloaded === false;
            return Effect.logInfo({ phase, retryable, body }).pipe(
              Effect.as(retryable),
            );
          }),
          Effect.catch(() => Effect.succeed(false)),
        );
      },
      schedule: Schedule.spaced("1 second"),
      times: 10,
    }),
    Effect.tapError((error) =>
      error.reason._tag === "StatusCodeError"
        ? error.reason.response.text.pipe(
            Effect.flatMap((body) => Effect.logError({ phase, url, body })),
          )
        : Effect.void,
    ),
    Effect.flatMap((res) => res.json as Effect.Effect<T>),
  );

describe.skipIf(!!process.env.FAST)(
  "DurableObjectState.abort resets the isolate",
  () => {
    test(
      "abort resets the Durable Object so the constructor re-runs",
      Effect.gen(function* () {
        const { url } = yield* stack;
        const client = yield* HttpClient.HttpClient;

        const before = yield* getJson<{ boots: number; ok: true }>(
          client,
          `${url}/ping`,
          "before abort",
        );
        expect(before.ok).toBe(true);
        expect(before.boots).toBeGreaterThanOrEqual(1);

        yield* expectUrlContains(`${url}/abort`, "aborted", {
          label: "abort RPC",
        });

        const after = yield* getJson<{ boots: number; ok: true }>(
          client,
          `${url}/ping`,
          "after abort",
        );
        expect(after.boots).toBe(before.boots + 1);
      }).pipe(logLevel),
      { timeout: 180_000 },
    );
  },
);
