import * as machines from "@distilled.cloud/fly-io/machines";
import * as Fly from "@/Fly";
import { waitHealthy } from "@/Fly/replicas";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  assertAppGone,
  census,
  checks,
  deployWorker,
} from "./fixtures/bluegreen.ts";

const { test } = Test.make({ providers: Fly.providers() });

test.provider(
  "S01 bluegreen worker checks, promotion, replacement, and graceful teardown",
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
      const committed = yield* machines.getMachine({
        app_name: first.appName,
        machine_id: first.machineId,
      });
      // Active commit metadata can reset reports after the provider's readiness validation.
      const machine = yield* waitHealthy(first.appName, committed, 30_000);
      expect(machine.instance_id).toBe(committed.instance_id);
      yield* Effect.logInfo("Observed promoted worker", {
        checks: machine.checks?.map(({ name, status }) => ({ name, status })),
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
      yield* stack.destroy();
      yield* assertAppGone(first.appName);
    }),
  { timeout: 180_000 },
);

test.provider(
  "S04 unhealthy replacement preserves the old routed ID and cleans unpromoted candidates",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const initial = yield* deployWorker(stack, "one");
      const failed = yield* deployWorker(stack, "broken", {
        checks: { ready: { ...checks.ready, path: "/missing" } },
        deploy: { strategy: "bluegreen", healthTimeout: "8 seconds" },
      }).pipe(Effect.result);
      expect(Result.isFailure(failed)).toBe(true);
      if (Result.isFailure(failed))
        expect(failed.failure).toMatchObject({
          _tag: "Fly.ReplicaChecksNotPassing",
        });
      const live = yield* census(initial.appName);
      expect(live.map((machine) => machine.id)).toEqual(initial.machineIds);
      expect(live[0]!.state).toBe("started");
      expect(live[0]!.cordoned).toBe(false);
      yield* stack.destroy();
      yield* assertAppGone(initial.appName);
    }),
  { timeout: 180_000 },
);
