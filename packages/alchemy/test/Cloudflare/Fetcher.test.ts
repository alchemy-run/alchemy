import { toHttpClient } from "@/Cloudflare/Fetcher";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

// A fetcher whose first `failures` calls die with the given message, then
// succeeds with a 200 — models a Durable Object / service script that is
// briefly mid-propagation after deploy.
const flakyFetcher = (failures: number, message: string) => {
  let attempts = 0;
  return {
    attempts: () => attempts,
    fetch: (_request: any) =>
      Effect.suspend(() => {
        attempts++;
        return attempts <= failures
          ? Effect.die(new Error(message))
          : Effect.succeed(HttpServerResponse.empty({ status: 200 }));
      }),
  };
};

describe("toHttpClient", () => {
  // `it.live` uses the real clock so the retry's backoff delays actually
  // elapse (the default `it.effect` TestClock would never advance them).
  it.live(
    "retries the just-deployed 'no fetch handler' propagation window",
    () =>
      Effect.gen(function* () {
        const fetcher = flakyFetcher(
          2,
          "Handler does not export a fetch() function.",
        );
        const client = toHttpClient(fetcher as any);

        const res = yield* client.get("http://do/").pipe(Effect.scoped);

        expect(res.status).toBe(200);
        // Two not-ready failures + one success.
        expect(fetcher.attempts()).toBe(3);
      }),
  );

  it.live("does not retry unrelated failures", () =>
    Effect.gen(function* () {
      const fetcher = flakyFetcher(99, "some other boom");
      const client = toHttpClient(fetcher as any);

      const outcome = yield* client
        .get("http://do/")
        .pipe(Effect.scoped, Effect.exit);

      expect(outcome._tag).toBe("Failure");
      // A non-propagation error is surfaced on the first attempt — no retry.
      expect(fetcher.attempts()).toBe(1);
    }),
  );
});
