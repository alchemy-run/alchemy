import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { getRouted, type Answer } from "@alchemy.run/test/IngressForwarder";
import type * as Ingress from "alchemy/Local/Ingress";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";
import type { Callbacks } from "./fixtures/async-circular-bindings/a.ts";
import type BEntrypoint from "./fixtures/async-circular-bindings/b.ts";

// The default topology of `alchemy dev`: the Worker provider runs in a sidecar
// process, which imports the ingress module and keeps the routes in its own
// process. The test sees only what a user would: the Worker's `url`, and what
// answers there.
const { test } = Test.make({ providers: Cloudflare.providers(), dev: true });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const workerMain = pathe.resolve(import.meta.dirname, "fixtures/ingress/worker.ts");
const callerMain = pathe.resolve(import.meta.dirname, "fixtures/ingress/caller.ts");
const viteRoot = pathe.resolve(import.meta.dirname, "fixtures/vite-url-fixture");
const cycleDir = pathe.resolve(import.meta.dirname, "fixtures/async-circular-bindings");

/** Route through the `@alchemy.run/test` forwarder, a real HTTP router. */
const forwarder = (name?: string): Ingress.Ingress => ({
  module: "@alchemy.run/test/IngressForwarder",
  name,
});

class NotReady extends Data.TaggedError("NotReady")<{ status: number; body: string }> {}

const retryUntilReady = Schedule.max([
  Schedule.min([Schedule.exponential("500 millis"), Schedule.spaced("2 seconds")]),
  Schedule.recurs(10),
]);

/** GET a routed origin until the freshly started workerd answers 200. */
const getRoutedReady = (origin: string, path = "/") =>
  getRouted(origin, path).pipe(
    Effect.orDie,
    Effect.flatMap((answer: Answer) =>
      answer.status === 200
        ? Effect.succeed(answer)
        : Effect.fail(new NotReady({ status: answer.status, body: answer.body })),
    ),
    Effect.retry({ while: (e) => e._tag === "NotReady", schedule: retryUntilReady }),
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
    Effect.retry({ while: (e) => e._tag === "NotReady", schedule: retryUntilReady }),
    Effect.orDie,
  );

const RAW_URL = /^http:\/\/localhost:(\d+)$/;
/** `http://<stage>.<name>.<stack>.localhost:<port>`, as the forwarder names it. */
const routedUrl = (name: string) =>
  new RegExp(`^http://[a-z0-9-]+\\.${name}\\.[a-z0-9-]+\\.localhost:\\d+$`);

/** A Worker, optionally routed, and a caller that reaches it over a service binding. */
const program = (ingress: Ingress.Ingress | undefined) =>
  Effect.gen(function* () {
    const target = yield* Cloudflare.Worker("IngressTarget", {
      main: workerMain,
      env: { SELF_URL: Cloudflare.Worker.URL },
      dev: ingress ? { ingress } : {},
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
    Effect.gen(function* () {
      yield* stack.destroy();

      // ── with ingress
      const routed = yield* stack.deploy(program(forwarder()));
      const origin = routed.target.url!;
      expect(origin).toMatch(routedUrl("ingresstarget"));
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

      // ── renaming the route moves the origin, not the listener
      const named = yield* stack.deploy(program(forwarder("named")));
      expect(named.target.url).toMatch(routedUrl("named"));
      expect(RAW_URL.exec(named.target.urls.find((url) => RAW_URL.test(url))!)![1]).toBe(rawPort);
      expect((yield* getRoutedReady(named.target.url!)).status).toBe(200);
      // The previous origin has no route any more.
      expect((yield* getRouted(origin)).status).toBe(502);

      // ── without ingress
      const plain = yield* stack.deploy(program(undefined));
      expect(plain.target.url).toBe(raw);
      expect(plain.target.urls).toEqual([raw]);
      expect((yield* getRouted(named.target.url!)).status).toBe(502);
      expect(yield* getRawReady(`${plain.target.url}/hello`)).toContain("ingress-worker");
      expect(JSON.parse(yield* getRawReady(`${plain.target.url}/self-url`))).toEqual({
        env: raw,
      });

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "local"],
    timeout: 240_000,
  },
);

test.provider(
  "a Vite Worker answers on its routed URL with the origin as its own URL",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const site = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Worker("IngressVite", {
            vite: {
              rootDir: viteRoot,
              memo: { include: ["index.html", "package.json", "vite.config.ts", "src/**"] },
            },
            compatibility: { date: "2024-09-23", flags: ["nodejs_compat"] },
            env: { VITE_PUBLIC_URL: Cloudflare.Worker.URL },
            dev: { ingress: forwarder() },
          });
        }),
      );

      const origin = site.url!;
      expect(origin).toMatch(routedUrl("ingressvite"));
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
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "local"],
    timeout: 300_000,
  },
);

/**
 * Two Workers that bind each other are cycle peers, so each is pre-created
 * before the other's outputs resolve. B routes with a constant ingress and is
 * routed already at pre-create. A's route name is B's `workerName`: still an
 * Output at A's pre-create, where A advertises its raw URL, and routed once
 * `start` sees it resolved. The router must never be handed the Output.
 */
test.provider(
  "Workers in a cycle route once an ingress name derived from a peer resolves",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const B = Cloudflare.Worker("IngressCycleB", {
        main: pathe.join(cycleDir, "b.ts"),
        env: {
          A_CALLBACKS: Effect.map(
            Effect.suspend((): Effect.Effect<Cloudflare.Worker, never, Cloudflare.Providers> => A),
            (a) => Cloudflare.WorkerEntrypoint<Callbacks>(a, "Callbacks"),
          ),
        },
        dev: { ingress: forwarder() },
      });
      const A = Cloudflare.Worker(
        "IngressCycleA",
        Effect.gen(function* () {
          const b = yield* B;
          return {
            main: pathe.join(cycleDir, "a.ts"),
            env: { B: Cloudflare.WorkerEntrypoint<BEntrypoint>(b) },
            dev: { ingress: { module: "@alchemy.run/test/IngressForwarder", name: b.workerName } },
          };
        }),
      );

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const a = yield* A;
          const b = yield* B;
          return { a, b };
        }),
      );

      // Both ended up on the forwarder; neither kept a raw stub URL. A's route
      // is named after B's resolved worker name, never an Output.
      const slug = deployed.b.workerName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      expect(deployed.a.url).toMatch(routedUrl(slug));
      expect(deployed.b.url).toMatch(routedUrl("ingresscycleb"));

      // A → B.start → A's Callbacks.done: both edges of the cycle still work.
      expect((yield* getRoutedReady(deployed.a.url!, "/?id=7")).body).toBe("a got 7");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "local"],
    timeout: 240_000,
  },
);
