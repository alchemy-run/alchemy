import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import {
  forwarderConfig,
  getRouted,
  makeForwarder,
  type Answer,
} from "@alchemy.run/test/IngressForwarder";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";
import type { Callbacks } from "./fixtures/async-circular-bindings/a.ts";
import type BEntrypoint from "./fixtures/async-circular-bindings/b.ts";

// In-process (`sidecar: false`): the test provides `Ingress.Adapters` around
// `stack.deploy`, which the sidecar's own process would never see. The code
// under test is the same either way; only where the adapter comes from differs.
const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
  sidecar: false,
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const workerMain = pathe.resolve(import.meta.dirname, "fixtures/ingress/worker.ts");
const callerMain = pathe.resolve(import.meta.dirname, "fixtures/ingress/caller.ts");
const viteRoot = pathe.resolve(import.meta.dirname, "fixtures/vite-url-fixture");
const cycleDir = pathe.resolve(import.meta.dirname, "fixtures/async-circular-bindings");

class NotReady extends Data.TaggedError("NotReady")<{ status: number; body: string }> {}

const retryUntilReady = Schedule.max([
  Schedule.min([Schedule.exponential("500 millis"), Schedule.spaced("2 seconds")]),
  Schedule.recurs(10),
]);

/** GET a routed origin until the freshly started workerd answers 200. */
const getRoutedReady = (origin: string, path = "/") =>
  getRouted(origin, path).pipe(
    Effect.flatMap((answer: Answer) =>
      answer.status === 200
        ? Effect.succeed(answer)
        : Effect.fail(new NotReady({ status: answer.status, body: answer.body })),
    ),
    Effect.retry({ while: (e) => e instanceof NotReady, schedule: retryUntilReady }),
    Effect.orDie,
  );

/** GET a raw `http://localhost:<port>` URL until it answers 200. */
const getRawReady = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(url);
    const body = yield* response.text;
    return response.status === 200
      ? body
      : yield* Effect.fail(new NotReady({ status: response.status, body }));
  }).pipe(
    Effect.retry({ while: (e) => e instanceof NotReady, schedule: retryUntilReady }),
    Effect.orDie,
  );

const RAW_URL = /^http:\/\/localhost:(\d+)$/;

/** A Worker, optionally routed, and a caller that reaches it over a service binding. */
const program = (ingress: boolean, options?: Record<string, unknown>, name?: string) =>
  Effect.gen(function* () {
    const target = yield* Cloudflare.Worker("IngressTarget", {
      main: workerMain,
      env: { SELF_URL: Cloudflare.Worker.URL },
      dev: ingress ? { ingress: { ...forwarderConfig(options), name } } : {},
    });
    const caller = yield* Cloudflare.Worker("IngressCaller", {
      main: callerMain,
      env: { TARGET: target },
    });
    return { target, caller };
  });

test.provider(
  "a Worker answers on its routed URL while bindings keep the raw listener, and removing ingress restores it",
  (stack) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* stack.destroy();
        const forwarder = yield* makeForwarder;

        const deploy = (ingress: boolean, options?: Record<string, unknown>) =>
          stack.deploy(program(ingress, options)).pipe(Effect.provide(forwarder.adapters));

        // ── with ingress
        const routed = yield* deploy(true);
        const origin = routed.target.url!;
        const route = [...forwarder.routes().values()].find((r) =>
          r.host.includes(".ingresstarget."),
        );
        expect(route).toBeDefined();
        expect(origin).toBe(`http://${route!.host}:${forwarder.port}`);
        // `urls[0]` is the origin; the local listener stays beside it.
        expect(routed.target.urls[0]).toBe(origin);
        const raw = routed.target.urls.find((url) => RAW_URL.test(url));
        expect(raw).toBeDefined();
        const rawPort = RAW_URL.exec(raw!)![1];

        // The routed name reaches the Worker with its Host.
        const answer = yield* getRoutedReady(origin, "/hello");
        expect(answer.body).toBe(`ingress-worker host=${new URL(origin).host} path=/hello`);
        // `Worker.URL` is the origin too.
        expect(JSON.parse((yield* getRoutedReady(origin, "/self-url")).body)).toEqual({
          env: origin,
        });
        // The listener still answers, and a service binding to the routed
        // Worker still works: bindings never go through the router.
        expect(yield* getRawReady(raw!)).toContain("ingress-worker");
        expect(yield* getRawReady(`${routed.caller.url}/`)).toContain(
          "caller saw: ingress-worker host=",
        );

        // ── editing ingress moves the origin, not the listener
        const edited = yield* deploy(true, { domain: "elsewhere" });
        expect(edited.target.url).toMatch(/\.elsewhere\.localhost:\d+$/);
        expect(edited.target.url).not.toBe(origin);
        expect(RAW_URL.exec(edited.target.urls.find((url) => RAW_URL.test(url))!)![1]).toBe(
          rawPort,
        );
        expect((yield* getRoutedReady(edited.target.url!)).status).toBe(200);
        // The previous origin has no route any more.
        expect((yield* getRouted(origin)).status).toBe(502);

        // ── a name in the config says what the route is called
        const named = yield* stack
          .deploy(program(true, undefined, "named"))
          .pipe(Effect.provide(forwarder.adapters));
        const [namedFqn] =
          [...forwarder.routes()].find(([, r]) => r.host.includes(".named.")) ?? [];
        expect(namedFqn).toBe("IngressTarget");
        expect(named.target.url).toMatch(/^http:\/\/[a-z0-9-]+\.named\.[a-z0-9-]+\.localhost:\d+$/);

        // ── without ingress
        const plain = yield* deploy(false);
        expect(plain.target.url).toBe(raw);
        expect(plain.target.urls).toEqual([raw]);
        expect(forwarder.routes().size).toBe(0);
        expect(yield* getRawReady(`${plain.target.url}/hello`)).toContain("ingress-worker");
        expect(JSON.parse(yield* getRawReady(`${plain.target.url}/self-url`))).toEqual({
          env: raw,
        });

        yield* stack.destroy();
        expect(forwarder.routes().size).toBe(0);
      }),
    ).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "local"],
    timeout: 240_000,
  },
);

test.provider(
  "a Vite Worker answers on its routed URL with the origin as its own URL",
  (stack) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* stack.destroy();
        const forwarder = yield* makeForwarder;

        const site = yield* stack
          .deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.Worker("IngressVite", {
                vite: {
                  rootDir: viteRoot,
                  memo: { include: ["index.html", "package.json", "vite.config.ts", "src/**"] },
                },
                compatibility: { date: "2024-09-23", flags: ["nodejs_compat"] },
                env: { VITE_PUBLIC_URL: Cloudflare.Worker.URL },
                dev: { ingress: forwarderConfig() },
              });
            }),
          )
          .pipe(Effect.provide(forwarder.adapters));

        const origin = site.url!;
        expect(origin).toBe(
          `http://${[...forwarder.routes().values()][0]!.host}:${forwarder.port}`,
        );
        expect(site.urls[0]).toBe(origin);
        expect(site.urls.some((url) => RAW_URL.test(url))).toBe(true);

        // The page is served through the route, and the Worker's own URL as the
        // child binds it is the origin. (The dev server doesn't inline it at
        // build time the way a deploy does.)
        expect((yield* getRoutedReady(origin, "/")).body).toContain("Worker.URL vite fixture");
        expect(JSON.parse((yield* getRoutedReady(origin, "/self-url")).body)).toEqual({
          env: origin,
        });

        yield* stack.destroy();
        expect(forwarder.routes().size).toBe(0);
      }),
    ).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "local"],
    timeout: 300_000,
  },
);

/**
 * Two Workers that bind each other are cycle peers, so each is pre-created
 * before the other's outputs resolve. B routes with a constant ingress and is
 * routed already at pre-create. A's ingress option is B's `workerName`: still
 * an Output at A's pre-create, where A advertises its raw URL, and routed once
 * `start` sees it resolved. The adapter must never be handed the Output.
 */
test.provider(
  "Workers in a cycle route once an ingress option derived from a peer resolves",
  (stack) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* stack.destroy();
        const forwarder = yield* makeForwarder;

        const B = Cloudflare.Worker("IngressCycleB", {
          main: pathe.join(cycleDir, "b.ts"),
          env: {
            A_CALLBACKS: Effect.map(
              Effect.suspend(
                (): Effect.Effect<Cloudflare.Worker, never, Cloudflare.Providers> => A,
              ),
              (a) => Cloudflare.WorkerEntrypoint<Callbacks>(a, "Callbacks"),
            ),
          },
          dev: { ingress: forwarderConfig() },
        });
        const A = Cloudflare.Worker(
          "IngressCycleA",
          Effect.gen(function* () {
            const b = yield* B;
            return {
              main: pathe.join(cycleDir, "a.ts"),
              env: { B: Cloudflare.WorkerEntrypoint<BEntrypoint>(b) },
              dev: { ingress: forwarderConfig({ domain: b.workerName }) },
            };
          }),
        );

        const deployed = yield* stack
          .deploy(
            Effect.gen(function* () {
              const a = yield* A;
              const b = yield* B;
              return { a, b };
            }),
          )
          .pipe(Effect.provide(forwarder.adapters));

        // Both ended up on the forwarder; neither kept a raw stub URL.
        const hosts = [...forwarder.routes().values()].map((route) => route.host);
        expect(deployed.a.url).toBe(
          `http://${hosts.find((host) => host.includes(".ingresscyclea."))}:${forwarder.port}`,
        );
        expect(deployed.b.url).toBe(
          `http://${hosts.find((host) => host.includes(".ingresscycleb."))}:${forwarder.port}`,
        );
        // A named its route after B's resolved worker name, never an Output.
        const domains = forwarder.made().flatMap((options) => options?.domain ?? []);
        expect(domains.length).toBeGreaterThan(0);
        expect(domains.every((domain) => typeof domain === "string")).toBe(true);
        expect(deployed.a.url).toContain(
          `.${deployed.b.workerName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.`,
        );

        // A → B.start → A's Callbacks.done: both edges of the cycle still work.
        expect((yield* getRoutedReady(deployed.a.url!, "/?id=7")).body).toBe("a got 7");

        yield* stack.destroy();
        expect(forwarder.routes().size).toBe(0);
      }),
    ).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "local"],
    timeout: 240_000,
  },
);

// The default topology of `alchemy dev`: the Worker provider runs in a sidecar
// process, which resolves the adapter from the package that contributes it
// (`@alchemy.run/test` contributes the forwarder, see `IngressContributions.ts`)
// and keeps the routes in its own process. The test sees only what a user would:
// the Worker's `url`, and what answers there.
const { test: sidecarTest } = Test.make({ providers: Cloudflare.providers(), dev: true });

sidecarTest.provider(
  "a Worker routes through an adapter the sidecar resolves from a contributing package",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const routed = yield* stack.deploy(program(true));
      const origin = routed.target.url!;
      expect(origin).toMatch(/^http:\/\/[a-z0-9-]+\.ingresstarget\.[a-z0-9-]+\.localhost:\d+$/);
      expect(routed.target.urls[0]).toBe(origin);
      const raw = routed.target.urls.find((url) => RAW_URL.test(url));
      expect(raw).toBeDefined();

      const answer = yield* getRoutedReady(origin, "/hello");
      expect(answer.body).toBe(`ingress-worker host=${new URL(origin).host} path=/hello`);
      expect(yield* getRawReady(`${routed.caller.url}/`)).toContain(
        "caller saw: ingress-worker host=",
      );

      // Removing `ingress` restores the listener and drops the sidecar's route.
      const plain = yield* stack.deploy(program(false));
      expect(plain.target.url).toBe(raw);
      expect((yield* getRouted(origin)).status).toBe(502);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "local"],
    timeout: 240_000,
  },
);
