import { fromCloudflareFetcher, toHttpClient } from "@alchemy.run/cloudflare/Fetcher";
import { describe, expect, it } from "@alchemy.run/test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpServerError from "effect/http/HttpServerError";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";

// Cloudflare's Fetcher includes methods beyond fetch. Model only the native
// fetch boundary, with one explicit cast where the stub enters the adapter.
type MockNativeFetch = (request: Request, options: { signal: AbortSignal }) => Promise<Response>;
const mockFetcher = (fetch: MockNativeFetch) =>
  fromCloudflareFetcher({
    fetch,
    connect: () => {
      throw new Error("connect not supported in test");
    },
  } as unknown as Parameters<typeof fromCloudflareFetcher>[0]);

// A Cloudflare fetcher whose first `failures` `.fetch()` calls reject with the
// given message, then resolve with a 200 — models a Durable Object / service
// binding that is briefly mid-propagation after deploy (workerd routes to a
// stale script version that has no fetch handler yet).
//
// The retry lives in `fromCloudflareFetcher` — the single adapter every CF
// binding flows through — NOT in any one higher-level wrapper (`toHttpClient`,
// the RPC DO transport, etc.), because the "no fetch handler" window is a
// property of invoking the binding itself, so every consumer should be
// resilient to it without re-implementing the retry.
const flakyFetcher = (failures: number, message: string) => {
  let attempts = 0;
  return {
    attempts: () => attempts,
    fetch: (_request: Request, _opts: { signal: AbortSignal }) => {
      attempts++;
      return attempts <= failures
        ? Promise.reject(new Error(message))
        : Promise.resolve(new Response(null, { status: 200 }));
    },
  };
};

describe("fromCloudflareFetcher", { tags: ["unit", "provider:cloudflare", "local"] }, () => {
  // `it.live` uses the real clock so the retry's backoff delays actually
  // elapse (the default `it.effect` TestClock would never advance them).
  it.live("retries the just-deployed 'no fetch handler' propagation window", () =>
    Effect.gen(function* () {
      const fetcher = flakyFetcher(2, "Handler does not export a fetch() function.");
      const client = mockFetcher(fetcher.fetch);

      const res = yield* client.fetch(HttpClientRequest.get("http://do/"));

      expect(res.status).toBe(200);
      // Two not-ready failures + one success.
      expect(fetcher.attempts()).toBe(3);
    }),
  );

  it.effect("does not retry unrelated failures", () =>
    Effect.gen(function* () {
      const fetcher = flakyFetcher(99, "some other boom");
      const client = mockFetcher(fetcher.fetch);

      const outcome = yield* client.fetch(HttpClientRequest.get("http://do/")).pipe(Effect.exit);

      expect(outcome._tag).toBe("Failure");
      // A non-propagation error is surfaced on the first attempt — no retry.
      expect(fetcher.attempts()).toBe(1);
    }),
  );

  it.effect("fails server requests with a typed InternalError and the original cause", () =>
    Effect.gen(function* () {
      const rejection = new TypeError("Network connection lost.");
      let attempts = 0;
      const fetcher = mockFetcher(() => {
        attempts++;
        return Promise.reject(rejection);
      });
      const request = HttpServerRequest.fromWeb(new Request("https://example.com/"));

      const error = yield* fetcher.fetch(request).pipe(Effect.flip);

      expect(HttpServerError.isHttpServerError(error)).toBe(true);
      expect(error.reason).toBeInstanceOf(HttpServerError.InternalError);
      expect(error.reason._tag).toBe("InternalError");
      expect(error.request).toBe(request);
      if (error.reason instanceof HttpServerError.InternalError) {
        expect(error.reason.cause).toBe(rejection);
      }
      expect(attempts).toBe(1);
    }),
  );

  it.effect("keeps client fetch rejections as defects, without retrying", () =>
    Effect.gen(function* () {
      const rejection = new TypeError("Network connection lost.");
      let attempts = 0;
      const fetcher = mockFetcher(() => {
        attempts++;
        return Promise.reject(rejection);
      });

      const exit = yield* fetcher
        .fetch(HttpClientRequest.get("https://example.com/"))
        .pipe(Effect.exit);

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const defect = Cause.findDefect(exit.cause);
        expect(Result.isSuccess(defect)).toBe(true);
        if (Result.isSuccess(defect)) expect(defect.success).toBe(rejection);
      }
      expect(attempts).toBe(1);
    }),
  );

  it.effect("keeps the native rejection available to toHttpClient callers", () =>
    Effect.gen(function* () {
      const rejection = new TypeError("Network connection lost.");
      const client = toHttpClient(mockFetcher(() => Promise.reject(rejection)));

      const error = yield* client.get("https://example.com/").pipe(Effect.flip);

      expect(error).toBeInstanceOf(HttpClientError.HttpClientError);
      expect(error.reason).toBeInstanceOf(HttpClientError.TransportError);
      if (error.reason instanceof HttpClientError.TransportError) {
        const serverError = error.reason.cause;
        expect(serverError).toBeInstanceOf(HttpServerError.HttpServerError);
        if (serverError instanceof HttpServerError.HttpServerError) {
          expect(serverError.reason).toBeInstanceOf(HttpServerError.InternalError);
          if (serverError.reason instanceof HttpServerError.InternalError) {
            expect(serverError.reason.cause).toBe(rejection);
          }
        }
      }
    }),
  );

  it.effect("captures synchronous fetch throws and non-Error rejections", () =>
    Effect.gen(function* () {
      const rejected = { code: "offline" };
      const throws = mockFetcher(() => {
        throw rejected;
      });
      const rejects = mockFetcher(() => Promise.reject(rejected));
      const request = HttpServerRequest.fromWeb(new Request("https://example.com/"));

      for (const fetcher of [throws, rejects]) {
        const error = yield* fetcher.fetch(request).pipe(Effect.flip);
        expect(error.reason).toBeInstanceOf(HttpServerError.InternalError);
        if (error.reason instanceof HttpServerError.InternalError) {
          expect(error.reason.cause).toBe(rejected);
        }
      }
    }),
  );

  it.effect(
    "interrupting a fetch aborts the native request without wrapping the interruption",
    () =>
      Effect.gen(function* () {
        let signal: AbortSignal | undefined;
        let started!: () => void;
        const whenStarted = new Promise<void>((resolve) => {
          started = resolve;
        });
        const fetcher = mockFetcher((_request, options) => {
          signal = options.signal;
          started();
          return new Promise<Response>((_resolve, reject) => {
            options.signal.addEventListener("abort", () => reject(new Error("Aborted")), {
              once: true,
            });
          });
        });

        const request = HttpServerRequest.fromWeb(new Request("https://example.com/"));
        const fiber = yield* fetcher.fetch(request).pipe(Effect.forkChild);
        yield* Effect.promise(() => whenStarted);
        yield* Fiber.interrupt(fiber);
        const exit = yield* Fiber.await(fiber);

        expect(signal?.aborted).toBe(true);
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          expect(Result.isSuccess(Cause.findInterrupt(exit.cause))).toBe(true);
          expect(Result.isSuccess(Cause.findDefect(exit.cause))).toBe(false);
        }
      }),
  );

  it.live("retries the propagation window for server requests too", () =>
    Effect.gen(function* () {
      const flaky = flakyFetcher(2, "Handler does not export a fetch() function.");
      const fetcher = mockFetcher(flaky.fetch);

      const response = yield* fetcher.fetch(
        HttpServerRequest.fromWeb(new Request("https://example.com/")),
      );

      expect(response.status).toBe(200);
      expect(flaky.attempts()).toBe(3);
    }),
  );

  it.live("replays a consumed POST body when a server request is retried", () =>
    Effect.gen(function* () {
      const bodies: string[] = [];
      const fetcher = mockFetcher(async (attempt) => {
        bodies.push(await attempt.text());
        if (bodies.length <= 2) throw new Error("Handler does not export a fetch() function.");
        return new Response(null, { status: 201 });
      });
      const request = HttpServerRequest.fromWeb(
        new Request("https://example.com/", { method: "POST", body: "original payload" }),
      );

      const response = yield* fetcher.fetch(request);

      expect(response.status).toBe(201);
      expect(bodies).toEqual(["original payload", "original payload", "original payload"]);
    }),
  );

  it.effect(
    "returns a typed server error when handler propagation never succeeds",
    () =>
      Effect.gen(function* () {
        const fetcher = flakyFetcher(99, "Handler does not export a fetch() function.");
        const request = HttpServerRequest.fromWeb(new Request("https://example.com/"));
        const client = mockFetcher(fetcher.fetch);

        const fiber = yield* client.fetch(request).pipe(Effect.exit, Effect.forkChild);
        yield* TestClock.adjust("30 seconds");
        const exit = yield* Fiber.join(fiber);

        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          const failure = Cause.findFail(exit.cause);
          expect(Result.isSuccess(failure)).toBe(true);
          if (Result.isSuccess(failure)) {
            const error = failure.success.error;
            expect(error.reason).toBeInstanceOf(HttpServerError.InternalError);
            expect(error.request).toBe(request);
            if (error.reason instanceof HttpServerError.InternalError) {
              expect(error.reason.cause).toBeInstanceOf(Error);
            }
          }
          expect(Result.isSuccess(Cause.findDefect(exit.cause))).toBe(false);
        }
        expect(fetcher.attempts()).toBe(9);
      }),
    { timeout: 5000 },
  );

  it.effect("preserves the original client defect after handler retries exhaust", () =>
    Effect.gen(function* () {
      const rejection = new Error("Handler does not export a fetch() function.");
      let attempts = 0;
      const fetcher = mockFetcher(() => {
        attempts++;
        return Promise.reject(rejection);
      });

      const fiber = yield* fetcher
        .fetch(HttpClientRequest.get("https://example.com/"))
        .pipe(Effect.exit, Effect.forkChild);
      yield* TestClock.adjust("30 seconds");
      const exit = yield* Fiber.join(fiber);

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const defect = Cause.findDefect(exit.cause);
        expect(Result.isSuccess(defect)).toBe(true);
        if (Result.isSuccess(defect)) expect(defect.success).toBe(rejection);
      }
      expect(attempts).toBe(9);
    }),
  );
});
