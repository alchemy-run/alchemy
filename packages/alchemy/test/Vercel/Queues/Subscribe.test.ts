/**
 * Vercel `subscribe` event source — the flagship end-to-end queue test,
 * live against the standing Vercel test team (doppler alchemy-v2/dev env).
 *
 * Path under test (all REAL platform push delivery, PROBES.md probe 4):
 *
 *   HTTP GET /send ──producer `SendMessage(Orders)` (deployment-pinned)──▶
 *   Vercel queue ──platform POST (queue/v2beta trigger on the separate
 *   `_alchemy-queue.func`, D9a)──▶ `subscribe(Orders, handler)` decodes the
 *   payload and echoes it into `Echoes` ──▶ HTTP GET /received drains
 *   `Echoes` on the PUBLIC function (`ReceiveMessages` binding, ambient
 *   OIDC) and reports the echo with its delivery metadata.
 *
 * The verification deliberately stays inside the deployed functions'
 * ambient scope: externally-minted project OIDC tokens are ALWAYS
 * `environment: development`-scoped (live-verified — there is no documented
 * or undocumented way to mint a production-scoped token), and the queue
 * namespace is per (project, environment), so an external data-plane client
 * cannot observe production queue traffic at all.
 *
 * Also pins the D9a two-function invariant: the PUBLIC fetch routes keep
 * serving even though the deployment carries queue triggers (a trigger on
 * the main function would 404 every public route — live-verified).
 */
import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import * as projects from "@distilled.cloud/vercel/projects";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { MinimumLogLevel } from "effect/References";
import SubscribeFn, { Orders, type Echo } from "./fixtures/subscribe-fn.ts";

const { test } = Test.make({ providers: Vercel.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Fresh .vercel.app URLs take a few seconds to start serving 200s — always
// retry the first request (bounded).
const readiness = Schedule.max([
  Schedule.exponential("500 millis"),
  Schedule.recurs(20),
]);

const getJson = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? response.json
        : Effect.fail(new Error(`status ${response.status}`)),
    ),
    Effect.retry({ schedule: readiness }),
  );

/** Poll (bounded) until the function's project is gone. */
const expectProjectGone = (projectId: string) =>
  Effect.gen(function* () {
    const { teamId } = yield* Vercel.VercelEnvironment.current;
    const gone = yield* projects
      .getProject({ idOrName: projectId, teamId })
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
  });

test.provider(
  "subscribe: platform push delivery end-to-end, public routes intact",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const fn = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* SubscribeFn;
        }),
      );
      expect(fn.url).toBeDefined();
      expect(fn.deploymentId).toBeTruthy();

      // 1. D9a: the PUBLIC function still serves HTTP even though the
      //    deployment carries queue triggers (they live on the separate
      //    consumer function).
      const root = (yield* getJson(`${fn.url}/`)) as { ok: boolean };
      expect(root.ok).toBe(true);

      // 2. Produce through the public fetch route — the in-function
      //    producer pins the send to the deployment partition (ambient
      //    VERCEL_DEPLOYMENT_ID + platform OIDC).
      const runId = yield* Effect.sync(() => crypto.randomUUID());
      const queued = (yield* getJson(
        `${fn.url}/send?runId=${runId}&orderId=flagship-1`,
      )) as { queued: boolean; orderId: string };
      expect(queued.queued).toBe(true);
      expect(queued.orderId).toEqual("flagship-1");

      // 3. The platform push-delivers to the consumer function; the
      //    subscribe handler decodes the payload and echoes it into
      //    `Echoes`; the public `/received` route drains the echo topic.
      //    Poll (bounded) until the echo for this run shows up.
      const drained = yield* getJson(`${fn.url}/received`).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (body) =>
            (body as unknown as { received: Echo[] }).received.some(
              (echo) => echo.runId === runId,
            ),
          times: 40,
        }),
      );
      const echo = (drained as unknown as { received: Echo[] }).received.find(
        (e) => e.runId === runId,
      );
      expect(echo).toBeDefined();
      // The full producer payload round-tripped through the push consumer…
      expect(echo!.orderId).toEqual("flagship-1");
      // …with real delivery metadata from the platform POST…
      expect(echo!.deliveryCount).toBeGreaterThanOrEqual(1);
      expect(echo!.topicName).toEqual(Orders.topicName);
      // …under the stable per-Function consumer group the trigger declares.
      expect(echo!.consumerGroup).toEqual("alchemy-SubscribeFn");

      // 4. Async-mode producer (`sendMessageFromEnv`): the Promise-based
      //    fromEnv client resolves the ambient OIDC token + deployment pin
      //    itself — same push-delivery loop verifies the send landed.
      const asyncRunId = yield* Effect.sync(() => crypto.randomUUID());
      const queuedAsync = (yield* getJson(
        `${fn.url}/send-async?runId=${asyncRunId}&orderId=fromenv-1`,
      )) as { queued: boolean; via: string };
      expect(queuedAsync.queued).toBe(true);
      expect(queuedAsync.via).toEqual("fromEnv");
      const drainedAsync = yield* getJson(`${fn.url}/received`).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (body) =>
            (body as unknown as { received: Echo[] }).received.some(
              (echo) => echo.runId === asyncRunId,
            ),
          times: 40,
        }),
      );
      const asyncEcho = (
        drainedAsync as unknown as { received: Echo[] }
      ).received.find((e) => e.runId === asyncRunId);
      expect(asyncEcho).toBeDefined();
      expect(asyncEcho!.orderId).toEqual("fromenv-1");

      // 5. Public routing still intact after deliveries.
      const after = (yield* getJson(`${fn.url}/`)) as { ok: boolean };
      expect(after.ok).toBe(true);

      // 6. Cleanup: owned project cascades; queue messages expire on their
      //    own (300s retention on both topics).
      yield* stack.destroy();
      yield* expectProjectGone(fn.projectId);
    }).pipe(logLevel),
  { timeout: 180_000 },
);
