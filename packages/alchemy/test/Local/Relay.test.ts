import * as ACME from "@/ACME";
import * as Cloudflare from "@/Cloudflare";
import * as Fly from "@/Fly";
import * as Alchemy from "@/index.ts";
import { DevRelay } from "@/Local/Relay/Relay.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as Dns from "node:dns/promises";
import IngressApiWorker from "../Cloudflare/Workers/fixtures/ingress/api-worker.ts";

/**
 * End to end through Fly: the dev relay service is deployed with its apex
 * certificate and DNS records on the standing test zone, a local dev
 * session connects to it over one WebSocket (the relay issues the
 * namespace's `*.<ns>.<domain>` certificate from ZeroSSL on that first
 * connect), and a public request for
 * `https://api.<namespace>.relay.alchemy-test-2.us` is answered by the
 * local Worker behind the dev ingress.
 *
 * Needs Fly + Cloudflare credentials and `ZERO_SSL_KEY`.
 */
const ZONE = process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";
const RELAY_DOMAIN = `${process.env.ALCHEMY_TEST_RELAY_SUBDOMAIN ?? "relay"}.${ZONE}`;
const RELAY_URL = `https://${RELAY_DOMAIN}`;
const NAMESPACE = "reltest";
const PORT = 13385;

const enabled =
  process.env.ZERO_SSL_KEY !== undefined ||
  process.env.ZEROSSL_ACCESS_KEY !== undefined;

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const providers = () =>
  Layer.mergeAll(Fly.providers(), Cloudflare.providers(), ACME.providers());

// The relay itself deploys for real.
const live = Test.make({ providers: providers() });

// The dev session runs locally behind the sidecar with the relay enabled.
const dev = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
  ingress: {
    domain: "localhost",
    port: PORT,
    relay: { url: RELAY_URL, namespace: NAMESPACE },
  },
});

// The relay reads its configuration through `Config`; set it before the
// stack is planned (the test process resolves the live stack's Config).
process.env.DEV_RELAY_ZONE = ZONE;
process.env.DEV_RELAY_DOMAIN = RELAY_DOMAIN;
process.env.DEV_RELAY_SCHEME = "https";

const RelayStack = Alchemy.Stack(
  "DevRelayTestStack",
  { providers: providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const relay = yield* DevRelay;
    return { url: relay.url, appName: relay.app.appName };
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

/** GET a public relay URL, retrying while DNS, TLS and the session settle. */
const getPublic = (
  url: string,
  ok: (status: number) => boolean = (status) => status === 200,
  headers: Record<string, string> = {},
  attempts = 45,
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
            Schedule.spaced("3 seconds"),
            Schedule.recurs(attempts),
          ]),
        }),
        Effect.catchTag("NotReady", (e) =>
          Effect.die(
            new Error(`relay answered ${e.status}: ${e.body.slice(0, 400)}`),
          ),
        ),
      );
  }).pipe(Effect.orDie);

// Deploy the relay, then wait until it actually answers: fresh DNS records
// and the apex certificate take a moment, and the connector's first attempt
// must not race that.
const relay = live.beforeAll(
  enabled
    ? Effect.gen(function* () {
        const deployed = yield* live.deploy(RelayStack);
        // Ask public DNS directly first: resolving through the OS before the
        // fresh record exists caches NXDOMAIN locally for minutes.
        yield* waitForDns(RELAY_DOMAIN);
        const res = yield* getPublic(
          `${RELAY_URL}/__relay/connect`,
          (status) => status === 426,
        );
        expect(res.status).toBe(426);
        return deployed;
      })
    : Effect.succeed({ url: "", appName: "" } as {
        url: string;
        appName: string;
      }),
);
live.afterAll.skipIf(!enabled || !!process.env.NO_DESTROY)(
  live.destroy(RelayStack),
);

dev.test.provider.skipIf(!enabled)(
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
      const publicUrl = `https://api.${NAMESPACE}.${RELAY_DOMAIN}`;
      // The relay URL is the primary one; the local ingress URL follows.
      expect(api.url).toBe(publicUrl);
      expect(api.urls).toContain(`http://api.localhost:${PORT}`);

      // The namespace's wildcard certificate is issued on first connect
      // (~a minute) and then propagates to Fly's edges (a few more); TLS
      // failures are retried until it serves.
      const res = yield* getPublic(
        `${publicUrl}/echo?x=1`,
        undefined,
        { origin: "http://web.example.com" },
        120,
      );
      const echo = (yield* res.json) as unknown as {
        method: string;
        forwardedHost: string | null;
        forwardedProto: string | null;
        origin: string | null;
      };
      expect(echo.method).toBe("GET");
      expect(echo.forwardedHost).toBe(`api.${NAMESPACE}.${RELAY_DOMAIN}`);
      expect(echo.forwardedProto).toBe("https");
      expect(echo.origin).toBe("http://web.example.com");
      // CORS headers come back through the relay untouched.
      expect(res.headers["access-control-allow-origin"]).toBe(
        "http://web.example.com",
      );

      // Destroying the Worker withdraws its route: the relay still forwards
      // (the sidecar keeps the session open for the whole test process) and
      // the local ingress answers 404 for the gone host — proof that
      // `unexpose` reaches through the relay. A 502 needs the session
      // itself to disconnect, which only happens when the sidecar exits.
      yield* stack.destroy();
      const gone = yield* getPublic(
        `${publicUrl}/`,
        (status) => status === 404,
        {},
        20,
      );
      expect(gone.status).toBe(404);
    }).pipe(logLevel),
  { timeout: 600_000 },
);
