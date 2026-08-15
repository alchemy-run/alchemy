/**
 * DEPTH.md row 3 — Queue web + schema evolution chain, live against the
 * standing Vercel test team (doppler alchemy-v2/dev env).
 *
 * One logical Function (`QueueEvoFn`) is reconciled through FOUR cycles,
 * each a full deploy of a different fixture version of the same resource:
 *
 *   C1  schema v1, default subscribe options — send → push-consume → echo
 *   C1b identical redeploy — deploymentId MUST NOT change (skip-on-hash)
 *   C2  subscribe option change (retryAfterSeconds: 45) — redeploy, trigger
 *       config verified OUT-OF-BAND in the consumer function's
 *       `.vc-config.json` (deployment files API), delivery still works
 *   C3  Topic schema EVOLVED (optional `note`) — both ends redeploy; a
 *       NEW-shape message round-trips AND an OLD-shape raw-JSON message
 *       (no schema encode, no `note`) still decodes through the consumer
 *   C4  subscribe removed — `_alchemy-queue.func` gone from the deployment
 *       files, public HTTP keeps serving, and the platform's verdict on
 *       producing into the now trigger-less topic is pinned
 *
 * Every cycle asserts what CHANGED (deploymentId on real changes) and what
 * STAYED STABLE (projectId, production URL, deploymentId on no-ops).
 *
 * Out-of-band verification is fully typed distilled: `listDeploymentFiles`
 * + `getDeploymentFileContents` (response schema patched — the OpenAPI doc
 * declares no 200 body but the live API returns `{ data: base64 }`).
 */
import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import * as deployments from "@distilled.cloud/vercel/deployments";
import * as projects from "@distilled.cloud/vercel/projects";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { MinimumLogLevel } from "effect/References";
import { type Echo } from "./fixtures/queue-evo-shared.ts";
import QueueEvoV1, { Orders } from "./fixtures/queue-evo-v1.ts";
import QueueEvoV2 from "./fixtures/queue-evo-v2.ts";
import QueueEvoV3 from "./fixtures/queue-evo-v3.ts";
import QueueEvoV4 from "./fixtures/queue-evo-v4.ts";

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

/**
 * Gate a cycle on the production alias actually serving the freshly
 * promoted deployment (the alias can lag the deploy by a few seconds).
 * Driving traffic before the flip would pin queue sends to the PREVIOUS
 * deployment's partition, making their deliveries invisible to this
 * cycle's consumers — queue visibility is per (deployment, environment).
 */
const awaitStage = (url: string, stage: number) =>
  getJson(`${url}/`).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (body) => (body as { stage?: number }).stage === stage,
      times: 30,
    }),
    Effect.map((body) => body as { ok: boolean; stage: number }),
  );

/** Poll `/received` (bounded) until an echo for `runId` shows up. */
const pollForEcho = (url: string, runId: string) =>
  Effect.gen(function* () {
    const drained = yield* getJson(`${url}/received`).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (body) =>
          (body as unknown as { received: Echo[] }).received.some(
            (echo) => echo.runId === runId,
          ),
        times: 30,
      }),
    );
    const echo = (drained as unknown as { received: Echo[] }).received.find(
      (e) => e.runId === runId,
    );
    expect(echo).toBeDefined();
    return echo!;
  });

// ─── Out-of-band deployment-file inspection (typed distilled) ───────────────

/** Resolve an exact child path from `nodes` (undefined when any segment is missing). */
const findExactPath = (
  nodes: ReadonlyArray<deployments.FileTree>,
  path: readonly string[],
): deployments.FileTree | undefined => {
  let current = nodes;
  let node: deployments.FileTree | undefined;
  for (const segment of path) {
    node = current.find((n) => n.name === segment);
    if (node === undefined) return undefined;
    current = node.children ?? [];
  }
  return node;
};

/** Depth-first search for a node reachable by `suffix` from any subtree. */
const findByPathSuffix = (
  nodes: ReadonlyArray<deployments.FileTree>,
  suffix: readonly string[],
): deployments.FileTree | undefined => {
  const direct = findExactPath(nodes, suffix);
  if (direct !== undefined) return direct;
  for (const node of nodes) {
    if (node.children !== undefined) {
      const found = findByPathSuffix(node.children, suffix);
      if (found !== undefined) return found;
    }
  }
  return undefined;
};

interface ConsumerVcConfig {
  readonly experimentalTriggers?: ReadonlyArray<{
    readonly type: string;
    readonly topic: string;
    readonly consumer: string;
    readonly retryAfterSeconds?: number;
    readonly initialDelaySeconds?: number;
  }>;
}

const CONSUMER_FUNC = "_alchemy-queue.func";

/** Fetch + parse a deployed function's `.vc-config.json` (undefined if the function is absent). */
const readVcConfig = (deploymentId: string, funcName: string) =>
  Effect.gen(function* () {
    const { teamId } = yield* Vercel.VercelEnvironment.current;
    const tree = yield* deployments.listDeploymentFiles({
      id: deploymentId,
      teamId,
    });
    // Guard: the tree is real (the public function is always present) so an
    // "absent consumer" can never be a trivially-empty response.
    expect(
      findByPathSuffix(tree, ["functions", "index.func", ".vc-config.json"]),
    ).toBeDefined();
    const file = findByPathSuffix(tree, [
      "functions",
      funcName,
      ".vc-config.json",
    ]);
    if (file?.uid === undefined) return undefined;
    const contents = yield* deployments.getDeploymentFileContents({
      id: deploymentId,
      fileId: file.uid,
      teamId,
    });
    return yield* Effect.sync(
      () =>
        JSON.parse(
          Buffer.from(contents.data, "base64").toString("utf8"),
        ) as ConsumerVcConfig,
    );
  });

test.provider(
  "queue chain: subscribe tuning, schema evolution, consumer removal across 4 reconcile cycles",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // ── C1: greenfield deploy, schema v1, default subscribe options ──────
      const v1 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* QueueEvoV1;
        }),
      );
      expect(v1.projectId).toBeTruthy();
      expect(v1.deploymentId).toBeTruthy();
      expect(v1.url).toBeTruthy();

      const root1 = yield* awaitStage(v1.url!, 1);
      expect(root1).toEqual({ ok: true, stage: 1 });

      const run1 = yield* Effect.sync(() => crypto.randomUUID());
      const queued1 = (yield* getJson(
        `${v1.url}/send?runId=${run1}&orderId=evo-1`,
      )) as { queued: boolean };
      expect(queued1.queued).toBe(true);

      const echo1 = yield* pollForEcho(v1.url!, run1);
      expect(echo1.orderId).toEqual("evo-1");
      expect(echo1.note).toBeUndefined();
      expect(echo1.topicName).toEqual(Orders.topicName);
      expect(echo1.consumerGroup).toEqual("alchemy-QueueEvoFn");
      expect(echo1.deliveryCount).toBeGreaterThanOrEqual(1);

      // Out-of-band: the consumer function carries BOTH triggers, and the
      // orders trigger has no retry tuning yet.
      const vc1 = yield* readVcConfig(v1.deploymentId!, CONSUMER_FUNC);
      expect(vc1).toBeDefined();
      const orders1 = vc1!.experimentalTriggers?.find(
        (t) => t.topic === Orders.topicName,
      );
      expect(orders1).toBeDefined();
      expect(orders1!.type).toEqual("queue/v2beta");
      expect(orders1!.consumer).toEqual("alchemy-QueueEvoFn");
      expect(orders1!.retryAfterSeconds).toBeUndefined();
      expect(
        vc1!.experimentalTriggers?.some(
          (t) => t.topic === "alchemy-qevo-echoes",
        ),
      ).toBe(true);

      // ── C1b: identical redeploy — nothing may change ─────────────────────
      const v1b = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* QueueEvoV1;
        }),
      );
      expect(v1b.projectId).toEqual(v1.projectId);
      expect(v1b.deploymentId).toEqual(v1.deploymentId);
      expect(v1b.url).toEqual(v1.url);

      // ── C2: subscribe option change (retryAfterSeconds: 45) ──────────────
      const v2 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* QueueEvoV2;
        }),
      );
      // Changed: the deployment (trigger config is part of the artifact).
      expect(v2.deploymentId).not.toEqual(v1.deploymentId);
      // Stable: project identity and the production alias.
      expect(v2.projectId).toEqual(v1.projectId);
      expect(v2.url).toEqual(v1.url);

      // Wait for the alias to flip to the new deployment before driving
      // queue traffic (sends are deployment-pinned).
      yield* awaitStage(v2.url!, 2);

      // Out-of-band: the trigger config update LANDED.
      const vc2 = yield* readVcConfig(v2.deploymentId!, CONSUMER_FUNC);
      const orders2 = vc2?.experimentalTriggers?.find(
        (t) => t.topic === Orders.topicName,
      );
      expect(orders2).toBeDefined();
      expect(orders2!.retryAfterSeconds).toEqual(45);
      expect(orders2!.consumer).toEqual("alchemy-QueueEvoFn");

      // Delivery still works on the new deployment partition.
      const run2 = yield* Effect.sync(() => crypto.randomUUID());
      const queued2 = (yield* getJson(
        `${v2.url}/send?runId=${run2}&orderId=evo-2`,
      )) as { queued: boolean };
      expect(queued2.queued).toBe(true);
      const echo2 = yield* pollForEcho(v2.url!, run2);
      expect(echo2.orderId).toEqual("evo-2");

      // ── C3: Topic schema evolution (optional `note`) ─────────────────────
      const v3 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* QueueEvoV3;
        }),
      );
      expect(v3.deploymentId).not.toEqual(v2.deploymentId);
      expect(v3.projectId).toEqual(v1.projectId);
      expect(v3.url).toEqual(v1.url);

      yield* awaitStage(v3.url!, 3);

      // Trigger config unchanged by the schema evolution.
      const vc3 = yield* readVcConfig(v3.deploymentId!, CONSUMER_FUNC);
      const orders3 = vc3?.experimentalTriggers?.find(
        (t) => t.topic === Orders.topicName,
      );
      expect(orders3?.retryAfterSeconds).toEqual(45);

      // NEW-shape message: the added field round-trips end-to-end.
      const run3new = yield* Effect.sync(() => crypto.randomUUID());
      const queued3 = (yield* getJson(
        `${v3.url}/send?runId=${run3new}&orderId=evo-3&note=evolved`,
      )) as { queued: boolean };
      expect(queued3.queued).toBe(true);
      const echo3 = yield* pollForEcho(v3.url!, run3new);
      expect(echo3.orderId).toEqual("evo-3");
      expect(echo3.note).toEqual("evolved");

      // OLD-shape message: raw v1 JSON (no `note`, no schema encode) still
      // decodes through the push consumer after the evolution.
      const run3old = yield* Effect.sync(() => crypto.randomUUID());
      const queuedRaw = (yield* getJson(
        `${v3.url}/send-raw?runId=${run3old}&orderId=evo-3-old`,
      )) as { queued: boolean; raw: boolean };
      expect(queuedRaw).toMatchObject({ queued: true, raw: true });
      const echoOld = yield* pollForEcho(v3.url!, run3old);
      expect(echoOld.orderId).toEqual("evo-3-old");
      expect(echoOld.note).toBeUndefined();

      // ── C4: remove subscribe — consumer function must vanish ─────────────
      const v4 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* QueueEvoV4;
        }),
      );
      expect(v4.deploymentId).not.toEqual(v3.deploymentId);
      expect(v4.projectId).toEqual(v1.projectId);
      expect(v4.url).toEqual(v1.url);

      // Public HTTP keeps serving (and the alias flipped to the new
      // deployment).
      const root4 = yield* awaitStage(v4.url!, 4);
      expect(root4).toEqual({ ok: true, stage: 4 });

      // Out-of-band: `_alchemy-queue.func` is gone from the deployment
      // (readVcConfig asserts index.func is still present, so this is not a
      // trivially-empty tree).
      const vc4 = yield* readVcConfig(v4.deploymentId!, CONSUMER_FUNC);
      expect(vc4).toBeUndefined();

      // Producing into the now trigger-less topic: DEPTH expects sends to
      // keep succeeding (messages just accumulate). The fixture surfaces
      // the typed rejection if the platform disagrees.
      const run4 = yield* Effect.sync(() => crypto.randomUUID());
      const send4 = (yield* getJson(
        `${v4.url}/send?runId=${run4}&orderId=evo-4`,
      )) as { queued: boolean; error?: string; message?: string };
      expect(send4.queued).toBe(true);

      // The poll-mode receive path (no trigger involved) also keeps working
      // — fresh deployment partition, so there is nothing to drain.
      const received4 = (yield* getJson(`${v4.url}/received`)) as {
        ok: boolean;
        count: number;
      };
      expect(received4.ok).toBe(true);
      expect(received4.count).toEqual(0);

      // ── Teardown + census ────────────────────────────────────────────────
      yield* stack.destroy();
      yield* expectProjectGone(v1.projectId!);
    }).pipe(logLevel),
  { timeout: 240_000 },
);
