import * as machines from "@distilled.cloud/fly-io/machines";
import * as Fly from "@/Fly";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: Fly.providers() });

test.provider(
  "bluegreen worker checks, promotion, replacement, and graceful teardown",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (version: string, path = "/") =>
        stack.deploy(
          Effect.gen(function* () {
            const app = yield* Fly.App("Site");
            return yield* Fly.Machine("Worker", {
              app,
              name: "bluegreen-worker-long-name-base",
              image: "nginx:alpine",
              env: { VERSION: version },
              deploy: { strategy: "bluegreen", healthTimeout: "30 seconds" },
              shutdown: { signal: "SIGQUIT", timeout: "10 seconds" },
              checks: {
                ready: {
                  type: "http",
                  port: 80,
                  path,
                  interval: "2s",
                  timeout: "1s",
                },
              },
            });
          }),
        );
      const first = yield* deploy("one");
      const machine = yield* machines.getMachine({
        app_name: first.appName,
        machine_id: first.machineId,
      });
      yield* Effect.logInfo("Observed promoted worker", {
        checks: machine.checks,
        configured: machine.config?.checks,
        metadata: machine.config?.metadata,
      });
      expect(machine.cordoned).toBe(false);
      expect(
        machine.checks?.some(
          (check) => check.name === "ready" && check.status === "passing",
        ),
      ).toBe(true);
      expect(machine.config?.metadata?.["alchemy.phase"]).toBe("active");
      expect(first.name.length).toBeLessThanOrEqual(30);
      const second = yield* deploy("two");
      expect(second.machineId).not.toBe(first.machineId);
      expect(second.baseName).toBe(first.baseName);
      const listed = yield* machines.listMachines({ app_name: first.appName });
      expect(
        listed
          .filter((machine) => machine.state !== "destroyed")
          .map((machine) => machine.id),
      ).toEqual([second.machineId]);
      const failed = yield* deploy("broken", "/missing").pipe(Effect.result);
      expect(Result.isFailure(failed)).toBe(true);
      if (Result.isFailure(failed))
        expect(failed.failure).toMatchObject({
          _tag: "Fly.ReplicaChecksNotPassing",
        });
      const survivor = yield* machines.getMachine({
        app_name: second.appName,
        machine_id: second.machineId,
      });
      expect(survivor.state).toBe("started");
      expect(survivor.cordoned).toBe(false);
      expect(
        (yield* machines.listMachines({ app_name: first.appName })).filter(
          (machine) => machine.state !== "destroyed",
        ),
      ).toHaveLength(1);
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);
