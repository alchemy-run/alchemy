import type { Input } from "@/Input.ts";
import * as Kubernetes from "@/Kubernetes";
import { connectCluster, readObject } from "@/Kubernetes/internal/client.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Kubernetes.providers() });

interface ObservedDeployment {
  metadata: {
    managedFields?: {
      manager: string;
      operation: string;
      fieldsV1?: { "f:spec"?: Record<string, unknown> };
    }[];
  };
  spec: {
    replicas: number;
    template: {
      spec: { containers: { env?: { name: string; value?: string }[] }[] };
    };
  };
}

// A Deployment plus a real HPA, as in the `Kubernetes.Deployment` docs.
const autoscaled = (
  cluster: Kubernetes.Connection,
  namespace: Input<string>,
  { name, value, replicas }: { name: string; value: string; replicas?: number },
) =>
  Effect.gen(function* () {
    const api = yield* Kubernetes.Deployment(name, {
      cluster,
      name,
      namespace,
      image: "nginx:1.27",
      port: 80,
      serviceType: "ClusterIP",
      resources: { requests: { cpu: "10m" } },
      env: { VALUE: value },
      ...(replicas !== undefined ? { replicas } : {}),
    });
    yield* Kubernetes.Manifest(`${name}-autoscaler`, {
      cluster,
      manifest: {
        apiVersion: "autoscaling/v2",
        kind: "HorizontalPodAutoscaler",
        metadata: { name, namespace: api.namespace },
        spec: {
          scaleTargetRef: {
            apiVersion: "apps/v1",
            kind: "Deployment",
            name: api.deploymentName,
          },
          // Below `minReplicas` the HPA scales up without reading metrics,
          // so the cluster doesn't need metrics-server.
          minReplicas: 3,
          maxReplicas: 5,
        },
      },
    });
    return api;
  });

// `hpa-unset` never sets `replicas`. `hpa-release` starts at `replicas: 1`,
// owned by Alchemy, then drops it, like an existing Deployment would.
const program = ({
  value,
  releaseReplicas,
}: {
  value: string;
  releaseReplicas?: number;
}) =>
  Effect.gen(function* () {
    const cluster = Kubernetes.KubeConfig({
      context: process.env.KUBERNETES_TEST_CONTEXT,
    });
    const ns = yield* Kubernetes.Manifest("Namespace", {
      cluster,
      manifest: {
        apiVersion: "v1",
        kind: "Namespace",
        metadata: { name: "alchemy-replicas-test" },
      },
    });
    const unset = yield* autoscaled(cluster, ns.name, {
      name: "hpa-unset",
      value,
    });
    const release = yield* autoscaled(cluster, ns.name, {
      name: "hpa-release",
      value,
      replicas: releaseReplicas,
    });
    return { unset, release };
  });

const observeDeployment = (api: Kubernetes.Deployment["Attributes"]) =>
  Effect.gen(function* () {
    const transport = yield* connectCluster(api.connection);
    return readObject({
      transport,
      object: {
        apiVersion: "apps/v1",
        kind: "Deployment",
        name: api.deploymentName,
        namespace: api.namespace,
      },
    }).pipe(Effect.map((object) => object as ObservedDeployment));
  });

const alchemyOwnsReplicas = (deployment: ObservedDeployment) =>
  "f:replicas" in
  ((deployment.metadata.managedFields ?? []).find(
    (entry) => entry.manager === "alchemy" && entry.operation === "Apply",
  )?.fieldsV1?.["f:spec"] ?? {});

const envValue = (deployment: ObservedDeployment) =>
  deployment.spec.template.spec.containers[0]?.env?.find(
    (entry) => entry.name === "VALUE",
  )?.value;

const logReplicas = (label: string, deployment: ObservedDeployment) =>
  Effect.logInfo(
    `${label}: replicas=${deployment.spec.replicas} alchemyOwnsReplicas=${alchemyOwnsReplicas(deployment)}`,
  );

// Waits for the HPA to scale the Deployment to `minReplicas`.
const untilScaledTo3 = <E, R>(
  observe: Effect.Effect<ObservedDeployment, E, R>,
) =>
  observe.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (deployment) => deployment.spec.replicas === 3,
      times: 45,
    }),
  );

// Gated: needs a reachable cluster, e.g.
// `KUBERNETES_TEST_CONTEXT=orbstack pnpm test test/Kubernetes/DeploymentAutoscaling.test.ts`.
test.provider.skipIf(!process.env.KUBERNETES_TEST_CONTEXT)(
  "a redeploy keeps the replica count a HorizontalPodAutoscaler set",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        program({ value: "a", releaseReplicas: 1 }),
      );
      const observeUnset = yield* observeDeployment(first.unset);
      const observeRelease = yield* observeDeployment(first.release);

      const applied = yield* observeRelease;
      yield* logReplicas("release after first deploy", applied);
      expect(alchemyOwnsReplicas(applied)).toBe(true);

      const unsetScaled = yield* untilScaledTo3(observeUnset);
      const releaseScaled = yield* untilScaledTo3(observeRelease);
      yield* logReplicas("unset after HPA scale", unsetScaled);
      yield* logReplicas("release after HPA scale", releaseScaled);
      expect(alchemyOwnsReplicas(unsetScaled)).toBe(false);
      // The HPA's write through `/scale` releases Alchemy's ownership.
      expect(alchemyOwnsReplicas(releaseScaled)).toBe(false);

      // Redeploy with a changed env var. `release` also drops `replicas`.
      yield* stack.deploy(program({ value: "b" }));
      for (const [label, observe] of [
        ["unset after redeploy", observeUnset],
        ["release after unsetting replicas", observeRelease],
      ] as const) {
        const redeployed = yield* observe;
        yield* logReplicas(label, redeployed);
        expect(envValue(redeployed)).toBe("b");
        expect(redeployed.spec.replicas).toBe(3);
        expect(alchemyOwnsReplicas(redeployed)).toBe(false);
      }

      yield* stack.destroy();
    }),
  {
    timeout: 240_000,
    tags: ["provider:kubernetes", "provider:kubernetes:deployment", "live"],
  },
);
