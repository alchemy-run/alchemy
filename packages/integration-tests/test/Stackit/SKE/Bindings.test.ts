import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as ske from "@distilled.cloud/stackit/ske";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { stackitTags } from "../helpers.ts";
import { CLUSTER_TEST_TIMEOUT, slow } from "./cluster.ts";
import SkeBindingsWorker, { Bound } from "./fixtures/worker.ts";

const providers = Layer.mergeAll(Stackit.providers(), Cloudflare.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "StackitSkeBindingsStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* SkeBindingsWorker;
    const cluster = yield* Bound;
    return {
      url: worker.url.as<string>(),
      projectId: cluster.projectId,
      region: cluster.region,
      clusterName: cluster.clusterName,
    };
  }),
);

type Body = { ok: boolean; result?: any; error?: string };

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

/** One state change: the bound cluster's 45-minute budget, plus the HTTP retries. */
const STEP_TIMEOUT = 50 * 60 * 1000;

// `blocked: cost`. The cluster for about four started hours, since hibernating,
// waking and rotating each take a while: about EUR 0.64 per run. Gated behind
// STACKIT_TEST_SLOW. The steps act on one cluster, so they run in order.
describe.sequential.skipIf(slow)(
  "STACKIT SKE bindings on a Cloudflare Worker",
  { tags: [...stackitTags("ske", "bindings"), "provider:cloudflare"] },
  () => {
    const stack = beforeAll(deploy(Stack), { timeout: CLUSTER_TEST_TIMEOUT });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: CLUSTER_TEST_TIMEOUT });

    // A fresh workers.dev URL, the created key and the account's memberships take
    // a while to propagate: retry until the route answers `ok`, then report the
    // last answer so a real failure shows its STACKIT error.
    const call = (route: string, params: Record<string, string> = {}) =>
      Effect.gen(function* () {
        const { url } = yield* stack;
        const query = new URLSearchParams(params).toString();
        return yield* HttpClient.get(`${url}${route}?${query}`).pipe(
          Effect.timeout("20 seconds"),
          Effect.flatMap((response) => response.json),
          Effect.map((body) => body as Body),
          Effect.flatMap((body) => (body?.ok ? Effect.succeed(body) : Effect.fail(body))),
          Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
          Effect.catch((body) => Effect.succeed(body as Body)),
        );
      });

    /** The cluster, out of band. */
    const observe = Effect.gen(function* () {
      const { projectId, region, clusterName } = yield* stack;
      return yield* ske.getCluster({
        projectId: projectId!,
        region: region!,
        clusterName: clusterName!,
      });
    });

    /** Bounded wait until the cluster satisfies `done`: every 15s for 45 minutes. */
    const waitForCluster = (done: (cluster: ske.Cluster) => boolean) =>
      observe.pipe(
        Effect.repeat({ schedule: Schedule.spaced("15 seconds"), until: done, times: 180 }),
      );

    const healthy = (cluster: ske.Cluster) => cluster.status?.aggregated === "STATE_HEALTHY";

    describe("GetCluster", () => {
      test(
        "reads the bound cluster",
        Effect.gen(function* () {
          const { clusterName } = yield* stack;
          const body = yield* call("/get-cluster");
          expectOk(body);
          expect(body.result.name).toBe(clusterName);
          expect(body.result.status.aggregated).toBe("STATE_HEALTHY");
        }),
        { timeout: 240_000 },
      );
    });

    describe("ListClusters", () => {
      test(
        "lists the clusters of the bound cluster's project and region",
        Effect.gen(function* () {
          const { clusterName } = yield* stack;
          const body = yield* call("/list-clusters");
          expectOk(body);
          expect(body.result.items.map((item: { name: string }) => item.name)).toContain(
            clusterName,
          );
        }),
        { timeout: 240_000 },
      );
    });

    describe("CreateKubeconfig", () => {
      test(
        "mints a kubeconfig with the requested lifetime",
        Effect.gen(function* () {
          const body = yield* call("/create-kubeconfig");
          expectOk(body);
          expect(body.result.returned).toBe(true);
          const remaining = new Date(body.result.expirationTimestamp).getTime() - Date.now();
          expect(remaining).toBeGreaterThan(0);
          // 600 seconds, give or take the clocks of both ends.
          expect(remaining).toBeLessThan(900 * 1000);
        }),
        { timeout: 240_000 },
      );
    });

    describe("ListProviderOptions", () => {
      test(
        "reads what the region offers",
        Effect.gen(function* () {
          const { region } = yield* stack;
          const body = yield* call("/list-provider-options", { region: region! });
          expectOk(body);
          expect(body.result.kubernetesVersions.length).toBeGreaterThan(0);
          expect(body.result.machineTypes.map((type: { name: string }) => type.name)).toContain(
            "c1.2",
          );
        }),
        { timeout: 240_000 },
      );
    });

    describe("TriggerHibernate", () => {
      test.provider(
        "hibernates the cluster",
        (_stack) =>
          Effect.gen(function* () {
            expectOk(yield* call("/hibernate"));
            const cluster = yield* waitForCluster(
              (live) => live.status?.aggregated === "STATE_HIBERNATED",
            );
            expect(cluster.status?.hibernated).toBe(true);
          }),
        { timeout: STEP_TIMEOUT },
      );
    });

    describe("TriggerWakeup", () => {
      test.provider(
        "wakes the cluster",
        (_stack) =>
          Effect.gen(function* () {
            expectOk(yield* call("/wakeup"));
            const cluster = yield* waitForCluster(healthy);
            expect(cluster.status?.hibernated ?? false).toBe(false);
          }),
        { timeout: STEP_TIMEOUT },
      );
    });

    describe("TriggerReconcile", () => {
      test.provider(
        "reconciles the cluster and it settles healthy",
        (_stack) =>
          Effect.gen(function* () {
            expectOk(yield* call("/reconcile"));
            const cluster = yield* waitForCluster(healthy);
            expect(cluster.status?.aggregated).toBe("STATE_HEALTHY");
          }),
        { timeout: STEP_TIMEOUT },
      );
    });

    describe("TriggerMaintenance", () => {
      test.provider(
        "runs maintenance and the cluster settles healthy",
        (_stack) =>
          Effect.gen(function* () {
            expectOk(yield* call("/maintain"));
            const cluster = yield* waitForCluster(healthy);
            expect(cluster.status?.aggregated).toBe("STATE_HEALTHY");
          }),
        { timeout: STEP_TIMEOUT },
      );
    });

    describe("StartCredentialsRotation", () => {
      test.provider(
        "prepares a rotation",
        (_stack) =>
          Effect.gen(function* () {
            expectOk(yield* call("/start-rotation"));
            const cluster = yield* waitForCluster(
              (live) => live.status?.credentialsRotation?.phase === "PREPARED",
            );
            expect(cluster.status?.credentialsRotation?.lastInitiationTime).toEqual(
              expect.any(String),
            );
          }),
        { timeout: STEP_TIMEOUT },
      );
    });

    describe("CompleteCredentialsRotation", () => {
      test.provider(
        "completes the rotation",
        (_stack) =>
          Effect.gen(function* () {
            expectOk(yield* call("/complete-rotation"));
            const cluster = yield* waitForCluster(
              (live) => live.status?.credentialsRotation?.phase === "COMPLETED",
            );
            expect(cluster.status?.credentialsRotation?.lastCompletionTime).toEqual(
              expect.any(String),
            );
          }),
        { timeout: STEP_TIMEOUT },
      );
    });
  },
);
