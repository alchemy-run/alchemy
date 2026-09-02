import * as Alchemy from "@/index.ts";
import * as Cloudflare from "@/Cloudflare/index.ts";
import { DevRelay } from "@/Local/Relay/Relay.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as Dns from "node:dns/promises";
import IngressApiWorker from "../Cloudflare/Workers/fixtures/ingress/api-worker.ts";

/**
 * End to end through the real edge: the dev relay (Worker + Durable Object)
 * is deployed on the standing test zone, a local dev session connects to it
 * over one WebSocket, and a public request for
 * `http://api.<namespace>.relay.alchemy-test-2.us` is answered by the local
 * Worker behind the dev ingress.
 *
 * Plain HTTP: Universal SSL covers one wildcard level only, and the test
 * hosts are two levels below the zone — a production relay puts Advanced
 * Certificate Manager on its zone.
 */
const ZONE = process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";
// Overridable so a run can sidestep a resolver that cached a negative
// answer for the default name (see `waitForDns`).
const RELAY_DOMAIN = `${process.env.ALCHEMY_TEST_RELAY_SUBDOMAIN ?? "relay"}.${ZONE}`;
const RELAY_URL = `http://${RELAY_DOMAIN}`;
const NAMESPACE = "reltest";
const PORT = 13385;

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// The relay itself deploys for real.
const live = Test.make({ providers: Cloudflare.providers() });

// The dev session runs locally behind the sidecar with the relay enabled.
const dev = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
  ingress: {
    domain: "localhost",
    port: PORT,
    tunnel: false,
    relay: { url: RELAY_URL, namespace: NAMESPACE },
  },
});

// The relay reads its configuration through `Config`; set it before the
// stack is planned (the test process resolves the live stack's Config).
process.env.DEV_RELAY_ZONE = ZONE;
process.env.DEV_RELAY_DOMAIN = RELAY_DOMAIN;
process.env.DEV_RELAY_SCHEME = "http";

const RelayStack = Alchemy.Stack(
  "DevRelayTestStack",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const relay = yield* DevRelay;
    return { url: relay.url, workerName: relay.worker.workerName };
  }),
);

class NotReady extends Data.TaggedError("NotReady")<{
  status: number;
  body: string;
}> {}

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

// Deploy the relay, then wait until the edge actually serves it: freshly
// created DNS records and Worker routes take a few seconds to propagate,
// and the connector's first attempt must not race that.
const relay = live.beforeAll(
  Effect.gen(function* () {
    const deployed = yield* live.deploy(RelayStack);
    // Ask public DNS directly first: resolving through the OS before the
    // fresh record exists caches NXDOMAIN locally for the zone's negative
    // TTL, and every later connect attempt would fail for minutes.
    yield* waitForDns(RELAY_DOMAIN);
    const client = yield* HttpClient.HttpClient;
    yield* client.get(`${RELAY_URL}/__relay/connect`).pipe(
      Effect.flatMap((res) =>
        res.status === 426
          ? Effect.void
          : Effect.fail(new NotReady({ status: res.status, body: "" })),
      ),
      Effect.retry({
        schedule: Schedule.max([
          Schedule.spaced("2 seconds"),
          Schedule.recurs(45),
        ]),
      }),
      Effect.orDie,
    );
    return deployed;
  }),
);
live.afterAll.skipIf(!!process.env.NO_DESTROY)(live.destroy(RelayStack));

/** GET a public relay URL, retrying while the edge/route/DNS propagate. */
const getPublic = (
  url: string,
  ok: (status: number) => boolean = (status) => status === 200,
  headers: Record<string, string> = {},
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client
      .execute(
        HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(headers)),
      )
      .pipe(
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
          schedule: Schedule.max([
            Schedule.spaced("2 seconds"),
            Schedule.recurs(30),
          ]),
        }),
        // Surface what the edge actually answered when it never settled.
        Effect.catchTag("NotReady", (e) =>
          Effect.die(
            new Error(`relay answered ${e.status}: ${e.body.slice(0, 400)}`),
          ),
        ),
      );
  }).pipe(Effect.orDie);

dev.test.provider(
  "a public relay URL is answered by the local Worker over one WebSocket",
  (stack) =>
    Effect.gen(function* () {
      yield* relay;
      yield* stack.destroy();

      const { api } = yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* IngressApiWorker;
          return { api };
        }),
      );
      const publicUrl = `http://api.${NAMESPACE}.${RELAY_DOMAIN}`;
      // The relay URL is the primary one; the local ingress URL follows.
      expect(api.url).toBe(publicUrl);
      expect(api.urls).toContain(`http://api.localhost:${PORT}`);

      const res = yield* getPublic(`${publicUrl}/echo?x=1`, undefined, {
        origin: "http://web.example.com",
      });
      const echo = (yield* res.json) as unknown as {
        method: string;
        forwardedHost: string | null;
        forwardedProto: string | null;
        origin: string | null;
      };
      expect(echo.method).toBe("GET");
      expect(echo.forwardedHost).toBe(`api.${NAMESPACE}.${RELAY_DOMAIN}`);
      expect(echo.forwardedProto).toBe("http");
      expect(echo.origin).toBe("http://web.example.com");
      // CORS headers come back through the relay untouched.
      expect(res.headers["access-control-allow-origin"]).toBe(
        "http://web.example.com",
      );

      // A namespace nobody is connected to is a clear 502, not a hang.
      const nobody = yield* getPublic(
        `http://api.nobody.${RELAY_DOMAIN}/`,
        (status) => status === 502,
      );
      expect(yield* nobody.text).toContain("alchemy dev is not connected");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 240_000 },
);
