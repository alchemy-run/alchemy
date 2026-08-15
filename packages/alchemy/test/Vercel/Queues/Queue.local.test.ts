/**
 * Vercel Queues dev-mode (`alchemy dev`) tests — the local queue broker per
 * the Local-tests doctrine: `dev: true` runs the RPC sidecar topology, so
 * the in-memory broker (and the local Function provider it delivers
 * through) lives in the sidecar process exactly like the real
 * `alchemy dev`.
 *
 * Local arm (no cloud calls — `dev:` identity proves it):
 *
 *   HTTP GET /send ──`SendMessage(DevOrders)` targets the sidecar broker
 *   via `VERCEL_QUEUE_BASE_URL`──▶ broker POSTs the CloudEvents v2beta
 *   delivery to the dev child's queue endpoint──▶ `subscribe(DevOrders)`
 *   decodes + echoes into `DevEchoes`──▶ GET /received drains the echo
 *   topic through `ReceiveMessages` (a dynamic consumer group against the
 *   broker) and acks each message.
 *
 * Remote arm: the SAME fixture piped through `Alchemy.remote()` deploys
 * live from a dev run — real project, real queue triggers, real platform
 * push — verified out-of-band via distilled and destroyed at the end.
 */
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import * as projects from "@distilled.cloud/vercel/projects";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import LocalQueueFn, {
  DevOrders,
  type DevEcho,
} from "./fixtures/local-queue-fn.ts";

const { test } = Test.make({
  providers: Vercel.providers(),
  dev: true,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

class NotReady extends Data.TaggedError("NotReady")<{ status: number }> {}

// The first request races the dev bundle's first build (rolldown over the
// alchemy barrel) locally, and workers.dev-style URL propagation remotely —
// retry with a bounded cap.
const readiness = Schedule.max([
  Schedule.min([
    Schedule.exponential("500 millis"),
    Schedule.spaced("2 seconds"),
  ]),
  Schedule.recurs(45),
]);

const getJsonReady = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.succeed(res)
          : Effect.fail(new NotReady({ status: res.status })),
      ),
      Effect.retry({
        while: (e): e is NotReady => e instanceof NotReady,
        schedule: readiness,
      }),
    );
    return yield* res.json;
  }).pipe(Effect.orDie);

test.provider(
  "local queue: broker push delivery end-to-end through the dev child",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const fn = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* LocalQueueFn;
        }),
      );

      // dev identity markers — proof no cloud call ran.
      expect(fn.projectId).toMatch(/^dev:/);
      expect(fn.deploymentId).toMatch(/^dev:/);
      expect(fn.url).toMatch(/^http:\/\/localhost:\d+$/);

      // Produce through the public route: the in-child producer pins the
      // send to the dev deployment partition and targets the local broker.
      const runId = yield* Effect.sync(() => crypto.randomUUID());
      const queued = (yield* getJsonReady(
        `${fn.url}/send?runId=${runId}&orderId=local-1`,
      )) as { queued: boolean; orderId: string };
      expect(queued.queued).toBe(true);
      expect(queued.orderId).toBe("local-1");

      // The broker push-delivers the CloudEvent to the child's queue-mode
      // bridge; the subscribe handler echoes into DevEchoes; /received
      // drains the echo topic back from the broker (dynamic group).
      const drained = yield* getJsonReady(`${fn.url}/received`).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (body) =>
            (body as unknown as { received: DevEcho[] }).received.some(
              (echo) => echo.runId === runId,
            ),
          times: 45,
        }),
      );
      const echo = (
        drained as unknown as { received: DevEcho[] }
      ).received.find((e) => e.runId === runId);
      expect(echo).toBeDefined();
      // The full payload round-tripped through the local push consumer…
      expect(echo!.orderId).toBe("local-1");
      // …with delivery metadata from the broker's CloudEvent POST…
      expect(echo!.deliveryCount).toBeGreaterThanOrEqual(1);
      expect(echo!.topicName).toBe(DevOrders.topicName);
      // …under the stable per-Function default consumer group.
      expect(echo!.consumerGroup).toBe("alchemy-LocalQueueFn");

      // Public HTTP routing stays intact alongside queue delivery.
      const root = (yield* getJsonReady(`${fn.url}/`)) as { ok: boolean };
      expect(root.ok).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 240_000 },
);

test.provider(
  "Alchemy.remote() queue Function deploys live during dev (real push)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const fn = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* LocalQueueFn;
        }).pipe(Alchemy.remote()),
      );

      // Real cloud identity — not the local emulator.
      expect(fn.projectId).not.toMatch(/^dev:/);
      expect(fn.url).toMatch(/^https:\/\//);

      // Real platform push delivery: produce, then drain the echo topic.
      const runId = yield* Effect.sync(() => crypto.randomUUID());
      const queued = (yield* getJsonReady(
        `${fn.url}/send?runId=${runId}&orderId=remote-1`,
      )) as { queued: boolean };
      expect(queued.queued).toBe(true);

      const drained = yield* getJsonReady(`${fn.url}/received`).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (body) =>
            (body as unknown as { received: DevEcho[] }).received.some(
              (echo) => echo.runId === runId,
            ),
          times: 40,
        }),
      );
      const echo = (
        drained as unknown as { received: DevEcho[] }
      ).received.find((e) => e.runId === runId);
      expect(echo).toBeDefined();
      expect(echo!.orderId).toBe("remote-1");
      expect(echo!.consumerGroup).toBe("alchemy-LocalQueueFn");

      // Out-of-band via distilled: the project exists on real Vercel.
      const { teamId } = yield* Vercel.VercelEnvironment.current;
      const project = yield* projects.getProject({
        idOrName: fn.projectId,
        teamId,
      });
      expect(project.id).toBe(fn.projectId);

      // Cleanup: the stamped-live row deletes from the real cloud even in
      // a dev run; queue messages expire on their own (300s retention).
      yield* stack.destroy();
      const gone = yield* projects
        .getProject({ idOrName: fn.projectId, teamId })
        .pipe(
          Effect.map(() => false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (g) => g,
            times: 10,
          }),
        );
      expect(gone).toBe(true);
    }).pipe(logLevel),
  { timeout: 240_000 },
);
