import { dependsOn } from "@/DependsOn";
import * as Kubernetes from "@/Kubernetes";
import { connectCluster, readObject } from "@/Kubernetes/internal/client.ts";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import { describe, expect } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

const testOptions = { providers: Kubernetes.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);

const Cluster = Kubernetes.LocalCluster("SettleCluster", {
  name: "alchemy-test-settle",
  registryPort: 5062,
  kubeconfig: ".alchemy/test-settle-cluster.kubeconfig",
});

const stack = Core.scratchStack(testOptions, "KubernetesSettle");

const readCreated = (
  connection: Kubernetes.Connection,
  object: { apiVersion: string; kind: string; name: string; namespace: string },
) =>
  connectCluster(connection).pipe(
    Effect.flatMap((transport) => readObject({ transport, object })),
    Effect.map(
      (o) =>
        (o as { metadata?: { creationTimestamp?: string } }).metadata
          ?.creationTimestamp,
    ),
    Effect.provide(Kubernetes.builtinAdapters()),
  );

const squash = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : "";

// Creates a real kind cluster; needs Docker and the kind CLI.
describe.skipIf(!process.env.KUBERNETES_TEST_KIND)(
  "Kubernetes eventual attributes",
  { tags: ["provider:kubernetes", "live"] },
  () => {
    beforeAll(stack.destroy(), { timeout: 180_000 });
    afterAll.skipIf(!!process.env.NO_DESTROY)(stack.destroy(), {
      timeout: 180_000,
    });

    test.provider(
      "dependsOn(job) applies the dependent after the Job completes",
      () =>
        Effect.gen(function* () {
          const out = yield* Effect.gen(function* () {
            const cluster = yield* Cluster;
            const migrate = yield* Kubernetes.Job("Migrate", {
              cluster,
              name: "migrate",
              image: "busybox:1.37",
              command: ["sh", "-c", "sleep 5"],
              backoffLimit: 0,
            });
            const web = yield* Kubernetes.Deployment("Web", {
              cluster,
              name: "web",
              image: "busybox:1.37",
              command: ["sh", "-c", "sleep 3600"],
              port: 8080,
              // Nothing reads `url`, so this must not wait for an address
              // the kind cluster will never assign.
              serviceType: "LoadBalancer",
            }).pipe(dependsOn(migrate));
            return {
              connection: cluster.connection,
              completedAt: migrate.completedAt,
              jobName: migrate.jobName,
              webUrl: web.deploymentName,
            };
          }).pipe(stack.deploy);

          expect(out.completedAt).toBeDefined();
          const deployedAt = yield* readCreated(out.connection, {
            apiVersion: "apps/v1",
            kind: "Deployment",
            name: "web",
            namespace: "default",
          });
          expect(new Date(deployedAt!).getTime()).toBeGreaterThanOrEqual(
            new Date(out.completedAt!).getTime(),
          );
        }),
      { timeout: 240_000 },
    );

    test.provider(
      "a failing Job fails the deploy before its dependents run",
      () =>
        Effect.gen(function* () {
          const exit = yield* Effect.gen(function* () {
            const cluster = yield* Cluster;
            const broken = yield* Kubernetes.Job("Broken", {
              cluster,
              name: "broken",
              image: "busybox:1.37",
              command: ["sh", "-c", "exit 3"],
              backoffLimit: 0,
            });
            yield* Kubernetes.Manifest("AfterBroken", {
              cluster,
              manifest: {
                apiVersion: "v1",
                kind: "ConfigMap",
                metadata: { name: "after-broken", namespace: "default" },
                data: { ok: "true" },
              },
            }).pipe(dependsOn(broken));
          }).pipe(stack.deploy, Effect.exit);

          expect(squash(exit)).toContain("failed: BackoffLimitExceeded");
        }),
      { timeout: 240_000 },
    );

    test.provider(
      "a Job whose image can't be pulled fails fast",
      () =>
        Effect.gen(function* () {
          const exit = yield* Effect.gen(function* () {
            const cluster = yield* Cluster;
            const job = yield* Kubernetes.Job("BadImage", {
              cluster,
              name: "bad-image",
              image: "localhost:5062/does-not-exist:1",
            });
            return { completedAt: job.completedAt };
          }).pipe(stack.deploy, Effect.exit);

          expect(squash(exit)).toContain("can't start");
        }),
      { timeout: 240_000 },
    );
  },
);
