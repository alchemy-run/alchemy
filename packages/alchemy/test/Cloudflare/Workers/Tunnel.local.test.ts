import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as Dns from "node:dns/promises";
import IngressApiWorker from "./fixtures/ingress/api-worker.ts";

/**
 * `alchemy dev --tunnel`: every exposed host also gets a public
 * `https://*.trycloudflare.com` URL through a Cloudflare quick tunnel.
 *
 * Needs the internet, a cloudflared binary (or the download to succeed),
 * and Cloudflare's quick-tunnel service — none of which CI can count on, so
 * the suite is gated behind `ALCHEMY_TEST_TUNNEL=1`. Run it locally:
 *
 *   ALCHEMY_TEST_TUNNEL=1 pnpm test test/Cloudflare/Workers/Tunnel.local.test.ts --profile testing
 */
const PORT = 13380;

const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
  ingress: { domain: "localhost", port: PORT, tunnel: true },
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

class NotReady extends Data.TaggedError("NotReady")<{
  status: number;
  body: string;
}> {}

/**
 * Wait until the fresh hostname exists in public DNS, asking an
 * authoritative-ish resolver (1.1.1.1) directly. A quick tunnel's name takes
 * up to ~30s to propagate, and asking the OS resolver too early caches a
 * negative answer for minutes — which then makes every `fetch` fail even
 * after the name is live.
 */
const waitForDns = (hostname: string) =>
  Effect.tryPromise(() => {
    const resolver = new Dns.Resolver();
    resolver.setServers(["1.1.1.1", "1.0.0.1"]);
    return resolver.resolve4(hostname);
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([
        Schedule.spaced("2 seconds"),
        Schedule.recurs(45),
      ]),
    }),
    Effect.orDie,
  );

/** GET through the public internet, retrying until the edge routes the new hostname. */
const getPublic = (url: string) =>
  Effect.gen(function* () {
    yield* waitForDns(new URL(url).hostname);
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.succeed(res)
          : res.text.pipe(
              Effect.flatMap((body) =>
                Effect.fail(new NotReady({ status: res.status, body })),
              ),
            ),
      ),
      // A fresh quick-tunnel hostname takes a few seconds to resolve, so
      // connection errors are retried too, not just non-200s.
      Effect.retry({
        schedule: Schedule.max([
          Schedule.spaced("2 seconds"),
          Schedule.recurs(30),
        ]),
      }),
    );
  }).pipe(Effect.orDie);

test.provider.skipIf(!process.env.ALCHEMY_TEST_TUNNEL)(
  "a tunneled worker is reachable from the internet at its trycloudflare URL",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { api } = yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* IngressApiWorker;
          return { api };
        }),
      );

      // The public URL is the primary one; the local ingress URL follows.
      expect(api.url).toMatch(/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/);
      expect(api.urls[1]).toBe(`http://api.localhost:${PORT}`);

      const res = yield* getPublic(`${api.url}/echo`);
      const echo = (yield* res.json) as unknown as {
        method: string;
        forwardedProto: string | null;
        forwardedHost: string | null;
      };
      expect(echo.method).toBe("GET");
      // cloudflared reports the public scheme; the ingress keeps what the
      // hop in front of it said instead of overwriting it with `http`.
      expect(echo.forwardedProto).toBe("https");
      expect(echo.forwardedHost).not.toBeNull();

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);
