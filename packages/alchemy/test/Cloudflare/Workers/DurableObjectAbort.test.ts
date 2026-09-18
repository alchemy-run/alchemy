import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { expectUrlContains } from "../Utils/Http.ts";
import Stack from "./fixtures/do-abort/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

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
    Effect.tapError((error) =>
      Effect.gen(function* () {
        if (error.reason._tag === "StatusCodeError") {
          const response = error.reason.response;
          const body = yield* response.text.pipe(
            Effect.catch(() => Effect.succeed("<unreadable response body>")),
          );
          yield* (response.status === 404 ? Effect.logDebug : Effect.logError)(
            `${phase}: GET ${response.request.url} returned ${response.status}`,
            body,
          );
        } else {
          yield* Effect.logError(`${phase}: GET ${url} failed`, error);
        }
      }),
    ),
    Effect.retry({
      while: (error) => {
        if (error.reason._tag !== "StatusCodeError") return false;
        const response = error.reason.response;
        return (
          (response.status === 404 &&
            (response.headers["content-type"] ?? "").includes("text/html")) ||
          // Only initial readiness may retry a platform-marked transient RPC failure.
          (phase === "before abort" &&
            response.status === 500 &&
            response.headers["x-do-retryable"] === "true")
        );
      },
      schedule: Schedule.spaced("1 second"),
      times: 10,
    }),
    Effect.flatMap((res) => res.json as Effect.Effect<T>),
  );

describe.skipIf(!!process.env.FAST)("DurableObjectState.abort resets the isolate", () => {
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
      yield* Effect.logInfo("before abort", before);
      expect(before.ok).toBe(true);
      expect(before.boots).toBeGreaterThanOrEqual(1);

      const aborted = yield* expectUrlContains(`${url}/abort`, "aborted", {
        label: "abort RPC",
      });
      yield* Effect.logInfo("abort RPC", aborted);
      expect(aborted).toContain("test abort");

      const after = yield* getJson<{ boots: number; ok: true }>(
        client,
        `${url}/ping`,
        "after abort",
      );
      yield* Effect.logInfo("after abort", after);
      expect(after.ok).toBe(true);
      expect(after.boots).toBe(before.boots + 1);
    }).pipe(logLevel),
    { timeout: 180_000 },
  );
});
