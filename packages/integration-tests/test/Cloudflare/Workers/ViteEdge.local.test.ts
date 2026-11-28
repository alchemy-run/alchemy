import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const rootDir = `${import.meta.dirname}/fixtures/vite-edge-fixture`;

const vite = {
  rootDir,
  memo: { include: ["index.html", "package.json", "vite.config.ts", "src/**"] },
};

const compatibility = { date: "2024-09-23", flags: ["nodejs_compat"] };

class NotServedBy extends Data.TaggedError("NotServedBy")<{
  expected: string;
  actual: unknown;
}> {}

class HmrSocketFailed extends Data.TaggedError("HmrSocketFailed")<{ message: string }> {}

interface Served {
  worker: string;
  url: string;
  host?: string;
  revision?: string;
}

/** A plain Worker that reports its own name and the URL it saw. */
const echo = (worker: string) => `export default {
  async fetch(request) {
    return Response.json({ worker: "${worker}", url: request.url });
  },
};`;

/**
 * GET `url` until the named Worker answers — routing changes land as the
 * edge router restarts, and the Vite child may still be starting.
 */
const expectServedBy = (url: string, worker: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(url).pipe(
      Effect.flatMap((res) => res.json),
      Effect.map((body) => body as unknown as Served | null),
      Effect.flatMap((body) =>
        body?.worker === worker
          ? Effect.succeed(body)
          : Effect.fail(new NotServedBy({ expected: worker, actual: body })),
      ),
      Effect.retry({
        schedule: Schedule.max([Schedule.spaced("500 millis"), Schedule.recurs(120)]),
      }),
    );
  }).pipe(Effect.orDie);

/** GET `url` until it answers 200, returning the body text. */
const getText = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? res.text.pipe(Effect.orDie)
          : Effect.fail(new NotServedBy({ expected: "200", actual: res.status })),
      ),
      Effect.retry({
        schedule: Schedule.max([Schedule.spaced("500 millis"), Schedule.recurs(120)]),
      }),
    );
  }).pipe(Effect.orDie);

/** Open Vite's HMR WebSocket on `url`; resolves with its first message. */
const firstHmrMessage = (url: string) =>
  Effect.callback<string, HmrSocketFailed>((resume) => {
    const socket = new WebSocket(url.replace(/^http/, "ws"), "vite-hmr");
    socket.onmessage = (event) => {
      resume(Effect.succeed(String(event.data)));
      socket.close();
    };
    socket.onerror = () => resume(Effect.fail(new HmrSocketFailed({ message: "socket error" })));
    return Effect.sync(() => socket.close());
  }).pipe(
    Effect.timeout("20 seconds"),
    Effect.retry({ schedule: Schedule.max([Schedule.spaced("500 millis"), Schedule.recurs(20)]) }),
    Effect.orDie,
  );

const HOST = "vite.alchemy-edge.test";

test.provider(
  "a Vite Worker on a custom domain federates with zone routes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (options: { usersRoute: boolean; revision?: string }) =>
        stack.deploy(
          Effect.gen(function* () {
            // The Vite Worker serves every path no route claims.
            const app = yield* Cloudflare.Website.Vite("ViteEdgeApp", {
              ...vite,
              compatibility,
              domain: HOST,
              env: { REVISION: options.revision ?? "one" },
            });
            const users = yield* Cloudflare.Worker("ViteEdgeUsers", {
              script: echo("users"),
              routes: options.usersRoute ? [{ pattern: `${HOST}/users/*` }] : [],
            });
            return { app, users };
          }),
        );

      const v1 = yield* deploy({ usersRoute: true });
      const url = v1.app.url!;
      expect(url).toMatch(/^http:\/\/localhost:\d+$/);

      // Fallback: the custom domain's Vite Worker answers unrouted paths,
      // and sees the public URL of the request through the router.
      const whoami = yield* expectServedBy(`${url}/whoami`, "vite");
      expect(whoami.url).toBe(`${url}/whoami`);

      // Path routing: `/users/*` leaves the router for the plain Worker.
      const user = yield* expectServedBy(`${url}/users/42?expand=true`, "users");
      expect(user.url).toBe(`${url}/users/42?expand=true`);

      // Assets: Vite transforms its own modules, through the edge.
      expect(yield* getText(`${url}/src/main.ts`)).toContain("vite-edge-fixture-main");
      expect(yield* getText(`${url}/@vite/client`)).toContain("vite");

      // HMR: the dev server's WebSocket upgrades through the router.
      expect(yield* firstHmrMessage(url)).toContain("connected");

      // Changing the environment restarts the child while its edge URL and
      // bridge registration remain stable.
      yield* deploy({ usersRoute: true, revision: "two" });
      const restarted = yield* expectServedBy(`${url}/whoami`, "vite");
      expect(restarted.revision).toBe("two");
      yield* expectServedBy(`${url}/users/42`, "users");
      expect(yield* getText(`${url}/src/main.ts`)).toContain("vite-edge-fixture-main");
      expect(yield* firstHmrMessage(url)).toContain("connected");

      // Removing the route hands `/users/*` back to the Vite Worker.
      yield* deploy({ usersRoute: false });
      yield* expectServedBy(`${url}/whoami`, "vite");
      const client = yield* HttpClient.HttpClient;
      const fallback = yield* client.get(`${url}/users/42`);
      expect(yield* fallback.text).not.toContain('"worker":"users"');

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "local"],
    timeout: 180_000,
  },
);

test.provider(
  "a standalone route sends Vite assets and HMR through the dev server",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { route } = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Cloudflare.Website.Vite("ViteStandaloneRoute", {
            ...vite,
            compatibility,
          });
          const route = yield* Cloudflare.Workers.WorkerRoute("ViteStandaloneRouteMapping", {
            zoneId: "edge-test-zone",
            pattern: "vite-standalone.alchemy-edge.test/*",
            script: app.workerName,
          });
          return { route };
        }),
      );
      const url = route.url!;
      yield* expectServedBy(`${url}/whoami`, "vite");
      expect(yield* getText(`${url}/@vite/client`)).toContain("vite");
      expect(yield* firstHmrMessage(url)).toContain("connected");
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:worker", "local"], timeout: 90_000 },
);

const OWNED_HOST = "vite-owned.alchemy-edge.test";

test.provider(
  "a route owned by the Vite Worker wins over another Worker's custom domain",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { origin } = yield* stack.deploy(
        Effect.gen(function* () {
          // A plain Worker owns the hostname; the Vite Worker owns one path.
          const origin = yield* Cloudflare.Worker("ViteOwnedOrigin", {
            script: echo("origin"),
            domain: OWNED_HOST,
          });
          const app = yield* Cloudflare.Website.Vite("ViteOwnedRoute", {
            ...vite,
            compatibility,
            routes: [{ pattern: `${OWNED_HOST}/whoami` }],
          });
          return { origin, app };
        }),
      );
      const url = origin.url!;

      // The route owned by the Vite Worker goes through its edge bridge...
      const whoami = yield* expectServedBy(`${url}/whoami`, "vite");
      expect(whoami.url).toBe(`${url}/whoami`);

      // ...and every path no route claims stays with the domain's Worker.
      yield* expectServedBy(`${url}/other`, "origin");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:worker", "local"], timeout: 90_000 },
);

test.provider(
  "an HTTPS Vite dev server fails routed requests with an error naming server.https",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { app } = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Cloudflare.Website.Vite("ViteEdgeHttps", {
            ...vite,
            rootDir: `${import.meta.dirname}/fixtures/vite-edge-https-fixture`,
            compatibility,
            // A domain with a matching route would put the public proxy
            // behind the plain-HTTP router; HTTPS must opt out of that.
            domain: "vite-https.alchemy-edge.test",
            routes: [{ pattern: "vite-https.alchemy-edge.test/api/*" }],
          });
          return { app };
        }),
      );

      // The Worker's own dev URL relays TLS untouched and keeps serving.
      expect(app.url).toMatch(/^https:\/\/localhost:\d+$/);
      const own = yield* HttpClient.HttpClient.pipe(
        Effect.flatMap((client) => client.get(`${app.url}/whoami`)),
        Effect.provideService(FetchHttpClient.RequestInit, {
          tls: { rejectUnauthorized: false },
        } as RequestInit),
        Effect.retry({
          schedule: Schedule.max([Schedule.spaced("500 millis"), Schedule.recurs(20)]),
        }),
      );
      expect(own.status).toBe(200);
      expect(((yield* own.json) as unknown as Served).worker).toBe("vite");

      // The route listener reaches the dev server over plain HTTP, so the
      // bridge answers with the reason instead of a bare connection error.
      const client = yield* HttpClient.HttpClient;
      const res = yield* client.get(`${app.routes[0]!.url!}/api/whoami`);
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(yield* res.text).toContain("server.https");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:worker", "local"], timeout: 90_000 },
);

const serverSourceModule = new URL("./fixtures/source-provider/server-provider.ts", import.meta.url)
  .href;

test.provider(
  "a server-mode source with a domain and matching routes stays off the edge router",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { app } = yield* stack.deploy(
        Effect.gen(function* () {
          // The source runs its own dev server and registers nothing under
          // the Worker's name, so the edge router cannot reach it. The
          // domain's route only matters if the Worker is put behind the
          // router, which a server-mode source must not be.
          const app = yield* Cloudflare.Worker("SourceServerDomain", {
            source: { provider: serverSourceModule, devMode: "server" },
            compatibility,
            domain: "source-server.alchemy-edge.test",
            routes: [{ pattern: "source-server.alchemy-edge.test/api/*" }],
          });
          return { app };
        }),
      );

      // The Worker's URL answers from the source's dev server directly.
      const served = yield* expectServedBy(`${app.url}/anything`, "source-server");
      expect(served.url).toBe("/anything");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:worker", "local"], timeout: 90_000 },
);

test.provider(
  "a routes-only Vite Worker is served on its own edge listener",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { app } = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Cloudflare.Website.Vite("ViteEdgeRoutesOnly", {
            ...vite,
            compatibility,
            routes: [{ pattern: "vite-only.alchemy-edge.test/*" }],
          });
          return { app };
        }),
      );

      const edgeUrl = app.routes[0]!.url!;
      expect(edgeUrl).toMatch(/^http:\/\/localhost:\d+$/);

      // The route host reaches Vite with its original `Host` (allowed by
      // the dev server's `allowedHosts`).
      const whoami = yield* expectServedBy(`${edgeUrl}/whoami`, "vite");
      expect(whoami.url).toBe(`${edgeUrl}/whoami`);
      expect(yield* getText(`${edgeUrl}/src/main.ts`)).toContain("vite-edge-fixture-main");
      expect(yield* firstHmrMessage(edgeUrl)).toContain("connected");

      // The Worker's own dev URL keeps serving it directly.
      yield* expectServedBy(`${app.url}/whoami`, "vite");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "local"],
    timeout: 180_000,
  },
);

const GAP_HOST = "vite-gap.alchemy-edge.test";
/** A request this slow was held while the Vite child restarted. */
const PARKED_MS = 300;

test.provider(
  "requests during a Vite dev-server restart are parked, not failed",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (revision: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const app = yield* Cloudflare.Website.Vite("ViteEdgeGap", {
              ...vite,
              compatibility,
              domain: GAP_HOST,
              env: { REVISION: revision },
              // A route on the host puts the custom domain behind the router.
              routes: [{ pattern: `${GAP_HOST}/never/*` }],
            });
            return { app };
          }),
        );

      const { app } = yield* deploy("one");
      const url = app.url!;
      expect((yield* expectServedBy(`${url}/whoami`, "vite")).revision).toBe("one");

      // Poll through the whole restart. The origin proxy parks connections
      // while the child is down, so every request must be answered 200.
      const client = yield* HttpClient.HttpClient;
      const observed: Array<{ status: number; revision?: string; ms: number }> = [];
      const poller = yield* Effect.gen(function* () {
        const started = yield* Clock.currentTimeMillis;
        const entry = yield* client.get(`${url}/whoami`).pipe(
          Effect.flatMap((res) =>
            res.json.pipe(
              Effect.map((body) => ({
                status: res.status,
                revision: (body as unknown as Served).revision,
              })),
            ),
          ),
          Effect.catch(() => Effect.succeed({ status: 0, revision: undefined })),
        );
        const ended = yield* Clock.currentTimeMillis;
        return { ...entry, ms: ended - started };
      }).pipe(
        Effect.tap((entry) => Effect.sync(() => observed.push(entry))),
        Effect.repeat({ schedule: Schedule.spaced("25 millis") }),
        Effect.forkChild,
      );

      yield* deploy("two");
      // The new child answers once it is exposed.
      const after = yield* expectServedBy(`${url}/whoami`, "vite");
      expect(after.revision).toBe("two");
      yield* Fiber.interrupt(poller);

      expect(observed.length).toBeGreaterThan(0);
      // The gap was really exercised: the poller is sequential, so the one
      // request in flight while the child was down is held by the origin
      // proxy and takes far longer than a normal request through the edge.
      const parked = observed.filter((entry) => entry.ms >= PARKED_MS);
      expect(parked.length).toBeGreaterThan(0);
      // Nothing failed or came back 5xx across the gap.
      expect(observed.filter((entry) => entry.status !== 200)).toEqual([]);
      // Only the two revisions were ever served.
      expect(observed.every((entry) => entry.revision === "one" || entry.revision === "two")).toBe(
        true,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:worker", "local"], timeout: 120_000 },
);

test.provider(
  "destroying a Vite Worker releases its edge listener and bridge",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = () =>
        stack.deploy(
          Effect.gen(function* () {
            const app = yield* Cloudflare.Website.Vite("ViteEdgeCleanup", {
              ...vite,
              compatibility,
              domain: "vite-cleanup.alchemy-edge.test",
              routes: [{ pattern: "vite-cleanup-routes.alchemy-edge.test/*" }],
            });
            return { app };
          }),
        );

      const first = yield* deploy();
      const url = first.app.url!;
      const listener = first.app.routes[0]!.url!;
      yield* expectServedBy(`${url}/whoami`, "vite");
      yield* expectServedBy(`${listener}/whoami`, "vite");

      yield* stack.destroy();

      // The public proxy and the route listener are closed.
      const client = yield* HttpClient.HttpClient;
      const refused = (target: string) =>
        client.get(target).pipe(
          Effect.timeout("5 seconds"),
          Effect.result,
          Effect.map((result) => result._tag === "Failure"),
        );
      expect(yield* refused(`${url}/whoami`)).toBe(true);
      expect(yield* refused(`${listener}/whoami`)).toBe(true);

      // A fresh deploy under the same names serves again: no stale bridge
      // registration or edge target is left behind.
      const second = yield* deploy();
      yield* expectServedBy(`${second.app.url!}/whoami`, "vite");
      yield* expectServedBy(`${second.app.routes[0]!.url!}/whoami`, "vite");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:worker", "local"], timeout: 120_000 },
);
