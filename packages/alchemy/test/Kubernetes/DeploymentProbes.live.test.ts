import * as Kubernetes from "@/Kubernetes";
import type { DeploymentProbe } from "@/Kubernetes/Deployment.ts";
import { connectCluster, readObject } from "@/Kubernetes/internal/client.ts";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

// Behavioral proof that Kubernetes acts on the generated probes, against any
// kubeconfig context (e.g. a local OrbStack / kind cluster). Each claim runs
// a control that must succeed next to a negative case that must fail, so a
// probe that is silently dropped or mis-ported fails the suite.
//
// Gated: set KUBERNETES_TEST_CONTEXT to a kubeconfig context. The namespace
// (KUBERNETES_TEST_NAMESPACE, default "alchemy-probes-test") must exist.
const context = process.env.KUBERNETES_TEST_CONTEXT;
const namespace =
  process.env.KUBERNETES_TEST_NAMESPACE ?? "alchemy-probes-test";

const { test } = Test.make({ providers: Kubernetes.providers() });

const cluster = Kubernetes.KubeConfig({ context });

const nginx = (
  name: string,
  probes: {
    readinessProbe?: DeploymentProbe;
    livenessProbe?: DeploymentProbe;
    startupProbe?: DeploymentProbe;
  },
) =>
  Kubernetes.Deployment(name, {
    cluster,
    name,
    namespace,
    image: "nginx:1.27",
    port: 80,
    serviceType: "ClusterIP",
    ...probes,
  });

type Attributes = Kubernetes.Deployment["Attributes"];

interface PodStatus {
  name: string;
  ready: boolean;
  restartCount: number;
}

interface Observed {
  /** The live container spec of the Deployment's pod template. */
  container: Record<string, any>;
  deployment: {
    readyReplicas: number;
    updatedReplicas: number;
    unavailableReplicas: number;
  };
  /** Pod names the Service routes traffic to. */
  readyEndpoints: string[];
  /** Pod names the Service holds back because they are not ready. */
  notReadyEndpoints: string[];
  pods: PodStatus[];
}

// Observe the live cluster: the Deployment, the Service's Endpoints (the
// traffic decision), and every pod the Endpoints reference.
const observe = (output: Attributes) =>
  Effect.gen(function* () {
    const transport = yield* connectCluster(output.connection);
    const deployment = (yield* readObject({
      transport,
      object: {
        apiVersion: "apps/v1",
        kind: "Deployment",
        name: output.deploymentName,
        namespace: output.namespace,
      },
    })) as any;
    const endpoints = (yield* readObject({
      transport,
      object: {
        apiVersion: "v1",
        kind: "Endpoints",
        name: output.serviceName,
        namespace: output.namespace,
      },
    }).pipe(Effect.catch(() => Effect.succeed({})))) as any;
    const podNames = (key: "addresses" | "notReadyAddresses"): string[] =>
      (endpoints.subsets ?? []).flatMap((subset: any) =>
        (subset[key] ?? []).map((address: any) => address.targetRef?.name),
      );
    const readyEndpoints = podNames("addresses");
    const notReadyEndpoints = podNames("notReadyAddresses");
    const pods = yield* Effect.forEach(
      [...readyEndpoints, ...notReadyEndpoints],
      (name) =>
        readObject({
          transport,
          object: { apiVersion: "v1", kind: "Pod", name, namespace },
        }).pipe(
          Effect.map((pod: any): PodStatus => {
            const status = pod.status?.containerStatuses?.[0];
            return {
              name,
              ready: status?.ready === true,
              restartCount: status?.restartCount ?? 0,
            };
          }),
        ),
    );
    return {
      container: deployment.spec.template.spec.containers[0],
      deployment: {
        readyReplicas: deployment.status?.readyReplicas ?? 0,
        updatedReplicas: deployment.status?.updatedReplicas ?? 0,
        unavailableReplicas: deployment.status?.unavailableReplicas ?? 0,
      },
      readyEndpoints,
      notReadyEndpoints,
      pods,
    } satisfies Observed;
  });

class NotYet extends Data.TaggedError("NotYet")<{ observed: Observed }> {}

// Poll until the cluster reaches the expected state (bounded: ~60s).
const waitFor = (output: Attributes, until: (o: Observed) => boolean) =>
  observe(output).pipe(
    Effect.flatMap((observed) =>
      until(observed)
        ? Effect.succeed(observed)
        : Effect.fail(new NotYet({ observed })),
    ),
    Effect.retry({
      while: (error) => error instanceof NotYet,
      schedule: Schedule.spaced("2 seconds"),
      times: 30,
    }),
  );

// Hold a negative state for a window, proving it is stable and not a
// transient before the pod converges.
const holds = (
  output: Attributes,
  invariant: (o: Observed) => boolean,
  samples = 8,
) =>
  Effect.forEach(Array.from({ length: samples }), () =>
    observe(output).pipe(
      Effect.tap((observed) =>
        Effect.sync(() =>
          expect(invariant(observed), JSON.stringify(observed)).toBe(true),
        ),
      ),
      Effect.delay("2 seconds"),
    ),
  ).pipe(Effect.map((observed) => observed.at(-1)!));

const log = (label: string, observed: Observed) =>
  Effect.sync(() =>
    console.log(
      label,
      JSON.stringify({
        readinessProbe: observed.container.readinessProbe,
        livenessProbe: observed.container.livenessProbe,
        startupProbe: observed.container.startupProbe,
        deployment: observed.deployment,
        readyEndpoints: observed.readyEndpoints,
        notReadyEndpoints: observed.notReadyEndpoints,
        pods: observed.pods,
      }),
    ),
  );

const podReady = (o: Observed) =>
  o.readyEndpoints.length === 1 && o.pods.every((pod) => pod.ready);

describe.skipIf(!context)("Kubernetes.Deployment probes (live cluster)", () => {
  test.provider(
    "readiness gates Service traffic",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const [pass, fail] = yield* stack.deploy(
          Effect.all([
            nginx("probe-ready-pass", {
              readinessProbe: { httpGet: { path: "/" }, periodSeconds: 1 },
            }),
            nginx("probe-ready-fail", {
              readinessProbe: { httpGet: { path: "/nope" }, periodSeconds: 1 },
            }),
          ]),
        );

        const control = yield* waitFor(pass, podReady);
        yield* log("readiness control", control);
        expect(control.container.readinessProbe.httpGet.port).toBe(80);

        // The 404 path keeps the pod out of the Service endpoints.
        const negative = yield* waitFor(
          fail,
          (o) => o.notReadyEndpoints.length === 1,
        );
        yield* holds(
          fail,
          (o) =>
            o.readyEndpoints.length === 0 &&
            o.notReadyEndpoints.length === 1 &&
            o.deployment.readyReplicas === 0,
        );
        yield* log("readiness negative", negative);

        yield* stack.destroy();
      }),
    { timeout: 120_000 },
  );

  test.provider(
    "liveness restarts an unhealthy container",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const [pass, fail] = yield* stack.deploy(
          Effect.all([
            nginx("probe-live-pass", {
              livenessProbe: {
                tcpSocket: {},
                periodSeconds: 1,
                failureThreshold: 1,
              },
            }),
            nginx("probe-live-fail", {
              livenessProbe: {
                tcpSocket: { port: 81 },
                periodSeconds: 1,
                failureThreshold: 1,
              },
            }),
          ]),
        );

        const negative = yield* waitFor(fail, (o) =>
          o.pods.some((pod) => pod.restartCount >= 1),
        );
        yield* log("liveness negative", negative);
        expect(negative.container.livenessProbe.tcpSocket.port).toBe(81);

        // The defaulted port (80) is healthy: no restarts over the window.
        yield* waitFor(pass, podReady);
        const control = yield* holds(
          pass,
          (o) => o.pods.length === 1 && o.pods[0]!.restartCount === 0,
        );
        yield* log("liveness control", control);
        expect(control.container.livenessProbe.tcpSocket.port).toBe(80);

        yield* stack.destroy();
      }),
    { timeout: 120_000 },
  );

  test.provider(
    "startup probe holds readiness and restarts on failure",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const readinessProbe: DeploymentProbe = {
          httpGet: { path: "/" },
          periodSeconds: 1,
        };
        const [pass, fail] = yield* stack.deploy(
          Effect.all([
            nginx("probe-start-pass", {
              readinessProbe,
              startupProbe: { exec: { command: ["true"] }, periodSeconds: 1 },
            }),
            nginx("probe-start-fail", {
              readinessProbe,
              startupProbe: {
                exec: { command: ["false"] },
                periodSeconds: 1,
                failureThreshold: 2,
              },
            }),
          ]),
        );

        const control = yield* waitFor(pass, podReady);
        yield* log("startup control", control);

        // nginx serves "/" (readiness would pass), yet the pod never turns
        // ready because the failing startup probe blocks readiness and
        // restarts the container.
        const negative = yield* waitFor(fail, (o) =>
          o.pods.some((pod) => pod.restartCount >= 1),
        );
        yield* holds(
          fail,
          (o) => o.readyEndpoints.length === 0 && o.pods.every((p) => !p.ready),
          5,
        );
        yield* log("startup negative", negative);

        yield* stack.destroy();
      }),
    { timeout: 120_000 },
  );

  test.provider(
    "a failing readiness probe holds a rolling update, and removal clears it",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const good = yield* stack.deploy(
          nginx("probe-rollout", {
            readinessProbe: { httpGet: { path: "/" }, periodSeconds: 1 },
          }),
        );
        const before = yield* waitFor(good, podReady);
        const oldPod = before.readyEndpoints[0]!;
        yield* log("rollout before", before);

        // Update to a failing readiness probe: the new pod never becomes
        // ready, so the old pod keeps serving and the rollout stalls.
        const bad = yield* stack.deploy(
          nginx("probe-rollout", {
            readinessProbe: { httpGet: { path: "/nope" }, periodSeconds: 1 },
          }),
        );
        const stalled = yield* waitFor(
          bad,
          (o) => o.notReadyEndpoints.length === 1,
        );
        yield* holds(
          bad,
          (o) =>
            o.readyEndpoints.length === 1 &&
            o.readyEndpoints[0] === oldPod &&
            o.notReadyEndpoints.length === 1 &&
            o.notReadyEndpoints[0] !== oldPod,
        );
        yield* log("rollout stalled", stalled);
        expect(stalled.container.readinessProbe.httpGet.path).toBe("/nope");

        // Remove the probe prop: server-side apply drops the field, and the
        // rollout completes.
        const removed = yield* stack.deploy(nginx("probe-rollout", {}));
        const after = yield* waitFor(
          removed,
          (o) =>
            podReady(o) &&
            o.notReadyEndpoints.length === 0 &&
            o.readyEndpoints[0] !== oldPod,
        );
        yield* log("rollout removed", after);
        expect("readinessProbe" in after.container).toBe(false);

        yield* stack.destroy();
      }),
    { timeout: 120_000 },
  );
});
