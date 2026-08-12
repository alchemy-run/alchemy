import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as pathe from "pathe";
import { cloneFixture } from "../Utils/Fixture.ts";
import EffectfulViteSite, { Users } from "./effectful-vite-fixture/site.ts";

// `dev: true` runs local providers behind the RPC sidecar proxy by default,
// matching the process topology of the real `alchemy dev` command. The
// Worker and Consumer lifecycles (vite child, consumer wiring, worker
// restart hooks) all run in the sidecar process.
const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const fixtureDir = pathe.resolve(import.meta.dirname, "vite-queue-fixture");
// Keep the temp clone under the workspace so Vite can express the project
// root relative to cwd (see the note on `tempRoot` in Vite.test.ts).
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");
const fixtureEntries = [
  "index.html",
  "package.json",
  "vite.config.ts",
  "worker.ts",
];

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
}> {}

const getJsonReady = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.succeed(res)
          : Effect.fail(new WorkerNotReady({ status: res.status })),
      ),
      Effect.retry({
        while: (e) => e instanceof WorkerNotReady,
        schedule: Schedule.max([
          Schedule.min([
            Schedule.exponential("500 millis"),
            Schedule.spaced("2 seconds"),
          ]),
          Schedule.recurs(15),
        ]),
      }),
    );
    return yield* res.json;
  }).pipe(Effect.orDie);

/**
 * Regression test for #1109: a `Queues.Consumer` registered against a
 * `Website.Vite` worker in dev. The Consumer depends on the site's
 * `workerName`, so the Vite child always boots before the consumer wiring
 * lands in `LocalRuntimeState` — the consumer's reconcile must then restart
 * the child through the `workerRestarts` hook (which `runVite` previously
 * never registered). Pre-fix, the producer binding resolved to the dev
 * registry's drop-and-warn stub: `queue()` never ran and `send()` hung.
 */
test.provider(
  "Vite dev: queue consumer on the site worker receives produced messages",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const rootDir = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-vite-queue-",
        tempRoot,
        entries: fixtureEntries,
      });

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const queue = yield* Cloudflare.Queues.Queue("ViteJobsQueue");
          const site = yield* Cloudflare.Website.Vite("ViteQueueSite", {
            rootDir,
            main: "worker.ts",
            workersDev: true,
            compatibility: {
              date: "2024-09-23",
              flags: ["nodejs_compat"],
            },
            memo: { include: fixtureEntries },
            assets: { runWorkerFirst: true },
            dev: { port: 0 },
            env: { QUEUE: queue },
          });
          yield* Cloudflare.Queues.Consumer("ViteJobsConsumer", {
            queueId: queue.queueId,
            scriptName: site.workerName,
            settings: { batchSize: 5, maxRetries: 2, maxWaitTimeMs: 500 },
          });
          return { queue, site };
        }),
      );

      // The queue is emulated (`dev:` id — proof no cloud call ran) and the
      // site serves from the local dev proxy.
      expect(deployed.queue.queueId).toMatch(/^dev:/);
      expect(deployed.site.url).toMatch(/^http:\/\/localhost:\d+$/);

      // `send()` resolves (pre-fix it hung forever against the registry's
      // drop stub)...
      const sent = (yield* getJsonReady(
        `${deployed.site.url}/api/send?text=vite-queue-hello`,
      ).pipe(Effect.timeout("60 seconds"))) as { sent: string };
      expect(sent.sent).toBe("vite-queue-hello");

      // ...and the broker delivers to the fixture's queue() handler.
      const received = yield* getJsonReady(
        `${deployed.site.url}/api/received`,
      ).pipe(
        Effect.map((body) => (body as { received: string[] }).received),
        Effect.repeat({
          schedule: Schedule.spaced("500 millis"),
          until: (received) => received.includes("vite-queue-hello"),
          times: 30,
        }),
      );
      expect(received).toContain("vite-queue-hello");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 240_000 },
);

const putTextJson = <T>(url: string, body: string) =>
  HttpClient.execute(
    HttpClientRequest.put(url).pipe(
      HttpClientRequest.bodyText(body, "text/plain"),
    ),
  ).pipe(
    Effect.flatMap((res) =>
      Effect.gen(function* () {
        if (res.status !== 200) {
          return yield* Effect.fail(new WorkerNotReady({ status: res.status }));
        }
        return yield* res.json;
      }),
    ),
    Effect.retry({
      while: (e) => e instanceof WorkerNotReady,
      schedule: Schedule.max([
        Schedule.min([
          Schedule.exponential("500 millis"),
          Schedule.spaced("2 seconds"),
        ]),
        Schedule.recurs(15),
      ]),
    }),
    Effect.orDie,
  ) as Effect.Effect<T, never, HttpClient.HttpClient>;

const getTextReady = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.succeed(res)
          : Effect.fail(new WorkerNotReady({ status: res.status })),
      ),
      Effect.retry({
        while: (e) => e instanceof WorkerNotReady,
        schedule: Schedule.max([
          Schedule.min([
            Schedule.exponential("500 millis"),
            Schedule.spaced("2 seconds"),
          ]),
          Schedule.recurs(15),
        ]),
      }),
    );
    return yield* res.text;
  }).pipe(Effect.orDie);

/**
 * The flagship wrapper-delivery roundtrip (DESIGN §6.2a) under `alchemy
 * dev`: the effectful Website's generated `virtual:alchemy:website-entry`
 * wrapper is served through the vite module runner inside workerd, the KV
 * capability binding resolves to the local simulator (a `dev:` id — proof
 * no cloud call ran), `server.routes` scopes the effect fetch to `/api/*`,
 * and the passthrough protocol falls through to the SPA asset layer.
 */
test.provider(
  "Vite dev: effectful website serves effect routes, KV dev binding, and passthrough",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const users = yield* Users;
          const site = yield* EffectfulViteSite;
          return { users, site };
        }),
      );

      // Local identities: the KV namespace is emulated and the site serves
      // from the local dev proxy.
      expect(deployed.users.namespaceId).toMatch(/^dev:/);
      expect(deployed.site.url).toMatch(/^http:\/\/localhost:\d+/);
      const base = deployed.site.url!;

      // Outside `server.routes`: the SPA shell serves from the asset layer.
      const shell = yield* getTextReady(`${base}/`);
      expect(shell).toContain("Effectful Vite fixture");

      // Inside `server.routes`: the effect fetch answers.
      const marker = (yield* getJsonReady(`${base}/api/anything`)) as {
        marker: string;
        path: string;
      };
      expect(marker.marker).toBe("effect-fetch");
      expect(marker.path).toBe("/api/anything");

      // KV roundtrip through the ReadWriteNamespace binding against the
      // local simulator.
      const put = yield* putTextJson<{ ok: boolean }>(
        `${base}/api/kv?key=greeting`,
        "hello-from-dev",
      );
      expect(put.ok).toBe(true);
      const got = (yield* getJsonReady(`${base}/api/kv?key=greeting`)) as {
        value: string | null;
      };
      expect(got.value).toBe("hello-from-dev");

      // Passthrough: the effect fetch declines and the request falls
      // through to the asset layer, whose SPA fallback serves the shell.
      const fallthrough = yield* getTextReady(`${base}/api/passthrough`);
      expect(fallthrough).toContain("Effectful Vite fixture");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 240_000 },
);
