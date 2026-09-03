import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type { HttpMethod } from "effect/unstable/http/HttpMethod";
import IngressApiWorker from "./fixtures/ingress/api-worker.ts";
import IngressWebWorker from "./fixtures/ingress/web-worker.ts";

/**
 * A fixed, unusual port so concurrently running dev suites (each with its
 * own sidecar and default-port ingress) never race this file's ingress.
 */
const PORT = 13370;

// `dev: true` runs local providers behind the RPC sidecar proxy (the
// `alchemy dev` topology); `ingress` turns on the shared `<name>.<domain>`
// front door exactly like `alchemy dev --port 13370` would.
const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
  ingress: { domain: "localhost", port: PORT },
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
 * Send a request to the ingress by IP with an explicit `Host` header — so
 * the test does not depend on the machine resolving `*.localhost` — and
 * retry until the freshly started workerd behind it answers non-5xx.
 */
const viaIngress = (
  host: string,
  path: string,
  options: {
    method?: HttpMethod;
    headers?: Record<string, string>;
    expect?: (status: number) => boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const ok = options.expect ?? ((status) => status < 500);
    const request = HttpClientRequest.make(options.method ?? "GET")(
      `http://127.0.0.1:${PORT}${path}`,
    ).pipe(
      // Browsers send the port in `Host` (`api.localhost:13370`); the ingress
      // routes on the hostname and forwards the header as sent.
      HttpClientRequest.setHeaders({
        host: `${host}:${PORT}`,
        ...options.headers,
      }),
    );
    return yield* client.execute(request).pipe(
      Effect.flatMap((res) =>
        ok(res.status)
          ? Effect.succeed(res)
          : res.text.pipe(
              Effect.flatMap((body) =>
                Effect.fail(new NotReady({ status: res.status, body })),
              ),
            ),
      ),
      Effect.retry({
        while: (e): e is NotReady => e instanceof NotReady,
        schedule: Schedule.max([
          Schedule.min([
            Schedule.exponential("500 millis"),
            Schedule.spaced("2 seconds"),
          ]),
          Schedule.recurs(10),
        ]),
      }),
    );
  }).pipe(Effect.orDie);

interface Echo {
  url: string;
  host: string | null;
  forwardedHost: string | null;
  forwardedProto: string | null;
  origin: string | null;
  cookie: string | null;
  method: string;
}

test.provider(
  "workers are served on <subdomain>.localhost through one shared port",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* IngressApiWorker;
          const web = yield* IngressWebWorker;
          return { api, web };
        }),
      );

      // The primary URL is the ingress host; the per-worker proxy URL stays
      // reachable and follows in `urls`.
      expect(deployed.api.url).toBe(`http://api.localhost:${PORT}`);
      expect(deployed.web.url).toBe(`http://web.localhost:${PORT}`);
      expect(deployed.api.urls[0]).toBe(`http://api.localhost:${PORT}`);
      expect(deployed.api.urls.slice(1)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^http:\/\/localhost:\d+$/),
        ]),
      );
      expect(deployed.api.workerId).toMatch(/^dev:/);

      // Host routing: each subdomain lands on its own worker, and the
      // worker learns the public host it was reached through.
      const apiRes = yield* viaIngress("api.localhost", "/echo");
      const api = (yield* apiRes.json) as unknown as Echo;
      expect(api.method).toBe("GET");
      expect(api.forwardedHost).toBe(`api.localhost:${PORT}`);
      expect(api.forwardedProto).toBe("http");

      const webRes = yield* viaIngress("web.localhost", "/whoami");
      const web = (yield* webRes.json) as unknown as { url: string };
      expect(web.url).toMatch(/\/whoami$/);
      // A request for the web host must never reach the API worker.
      expect(web).not.toHaveProperty("forwardedHost");

      // An unknown host is a 404 that lists the known hosts (never a
      // silent fall-through to some worker).
      const unknown = yield* viaIngress("nope.localhost", "/", {
        headers: { accept: "application/json" },
        expect: (status) => status === 404,
      });
      const body = (yield* unknown.json) as unknown as {
        error: { hosts: string[] };
      };
      expect(body.error.hosts).toEqual(["api.localhost", "web.localhost"]);

      // The bare address is a directory of resources once there is more
      // than one.
      const index = yield* viaIngress("localhost", "/", {
        headers: { accept: "text/html" },
        expect: (status) => status === 200,
      });
      const html = yield* index.text;
      expect(html).toContain(`http://api.localhost:${PORT}`);
      expect(html).toContain(`http://web.localhost:${PORT}`);

      yield* stack.destroy();

      // Routes are dropped with the workers.
      const gone = yield* viaIngress("api.localhost", "/echo", {
        headers: { accept: "application/json" },
        expect: (status) => status === 404,
      });
      expect(gone.status).toBe(404);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "CORS preflights and domain cookies pass through the ingress untouched",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* IngressApiWorker;
          return { api };
        }),
      );

      const origin = `http://web.localhost:${PORT}`;

      // Preflight: OPTIONS with the browser's CORS request headers must reach
      // the worker and its CORS response headers must come back intact.
      const preflight = yield* viaIngress("api.localhost", "/echo", {
        method: "OPTIONS",
        headers: {
          origin,
          "access-control-request-method": "GET",
          "access-control-request-headers": "content-type,x-custom",
        },
        expect: (status) => status === 204,
      });
      expect(preflight.headers["access-control-allow-origin"]).toBe(origin);
      expect(preflight.headers["access-control-allow-credentials"]).toBe(
        "true",
      );
      expect(preflight.headers["access-control-allow-headers"]).toBe(
        "content-type,x-custom",
      );

      // Actual request: the Origin header arrives unmodified and the
      // response echoes it back.
      const actual = yield* viaIngress("api.localhost", "/echo", {
        headers: { origin, cookie: "session=abc" },
      });
      const echo = (yield* actual.json) as unknown as Echo;
      expect(echo.origin).toBe(origin);
      expect(echo.cookie).toBe("session=abc");
      expect(actual.headers["access-control-allow-origin"]).toBe(origin);

      // A domain-scoped Set-Cookie (the cross-subdomain session pattern)
      // is forwarded verbatim — nothing rewrites the Domain attribute.
      const cookie = yield* viaIngress(
        "api.localhost",
        "/cookie?domain=localhost",
      );
      expect(cookie.headers["set-cookie"]).toContain("Domain=localhost");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
