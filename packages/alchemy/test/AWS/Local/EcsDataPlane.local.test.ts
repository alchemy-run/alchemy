/**
 * Dev-mode data-plane routing for the hand-written floci providers.
 *
 * `ECS.Cluster` is a `flociDual` (which declares the floci emulator as the
 * resource's local data plane), while `ECS.Task` / `ECS.Service` /
 * `Lambda.Function` are hand-written `ProviderLayer.dual` registrations
 * whose local variants ALSO run on floci. If those don't declare the data
 * plane, a binding that spans both kinds — `RunTask(cluster, task)` — sees
 * one resource routed to the emulator and the other to nothing, and dies at
 * bind time with "Binding client spans mixed data planes", before anything
 * is provisioned. Reported with exactly this four-line program:
 *
 *   const cluster = yield* AWS.ECS.Cluster("Cluster")
 *   const task = yield* AWS.ECS.Task("Task", { image: "busybox:stable", command: ["true"] })
 *   yield* AWS.ECS.RunTask(cluster, task)
 *
 * Requires Docker (floci runs as a container); skipped when unavailable.
 */
import { Action } from "@/Action";
import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { dockerAvailable } from "./fixtures/raw.ts";

const { test } = Test.make({ providers: AWS.providers(), dev: true });

/** The emulator runs task containers on THIS machine. */
const hostRuntimePlatform = {
  cpuArchitecture:
    process.arch === "arm64" ? ("ARM64" as const) : ("X86_64" as const),
  operatingSystemFamily: "LINUX" as const,
};

test.provider.skipIf(!dockerAvailable)(
  "RunTask(cluster, task) binds in dev and routes the launch to floci",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const outputs = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* AWS.ECS.Cluster("DataPlaneCluster");
          const task = yield* AWS.ECS.Task("DataPlaneTask", {
            image: "busybox:stable",
            command: ["true"],
            cpu: 256,
            memory: 512,
            requiresCompatibilities: ["EC2"],
            runtimePlatform: hostRuntimePlatform,
          });

          // The deploy-time client path (#1308): an Action binds
          // RunTask(cluster, task) — this bind is where the data-plane check
          // runs — and launches the task. Its call must land on the
          // emulator, not the real cloud.
          const Launch = Action(
            "LaunchDataPlaneTask",
            Effect.gen(function* () {
              const runTask = yield* AWS.ECS.RunTask(cluster, task);
              return () =>
                runTask({ launchType: "EC2", count: 1 }).pipe(
                  Effect.map((response) => ({
                    taskArn: response.tasks?.[0]?.taskArn,
                    failures: response.failures ?? [],
                  })),
                );
            }),
          );
          return {
            clusterArn: cluster.clusterArn,
            launched: yield* Launch({}),
          };
        }).pipe(Effect.provide(AWS.ECS.RunTaskHttp)),
      );

      // Emulator-shaped identity: the live cloud can never mint these.
      expect(outputs.clusterArn).toContain(":000000000000:");
      expect(outputs.launched.failures).toEqual([]);
      expect(outputs.launched.taskArn).toContain(":000000000000:");

      yield* stack.destroy();
    }),
  { timeout: 300_000 },
);
