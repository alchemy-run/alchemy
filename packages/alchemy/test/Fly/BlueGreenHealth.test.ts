import * as Fly from "@/Fly";
import { waitHealthy } from "@/Fly/replicas";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  assertAppGone,
  assertCommitted,
  census,
  checks,
  deployWorker,
} from "./fixtures/bluegreen.ts";

const { test } = Test.make({ providers: Fly.providers() });

for (const kind of ["named", "multiple published services"] as const) {
  test.provider(
    `S03 every ${kind} check must pass before blue retirement`,
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const initial = yield* deployWorker(stack, "one", {
          deploy: { strategy: "bluegreen", healthTimeout: "30 seconds" },
        });
        const extra = { ...checks.ready, path: "/does-not-exist" };
        const failed = yield* deployWorker(stack, "two", {
          checks:
            kind === "named"
              ? { ready: checks.ready, dependency: extra }
              : checks,
          services:
            kind === "named"
              ? undefined
              : [
                  {
                    protocol: "tcp",
                    internalPort: 80,
                    ports: [{ port: 80, handlers: ["http"] }],
                    checks: [checks.ready],
                  },
                  {
                    protocol: "tcp",
                    internalPort: 80,
                    ports: [{ port: 443, handlers: ["tls", "http"] }],
                    checks: [extra],
                  },
                ],
          deploy: { strategy: "bluegreen", healthTimeout: "8 seconds" },
        }).pipe(Effect.result);
        expect(Result.isFailure(failed)).toBe(true);
        if (Result.isFailure(failed))
          expect(failed.failure).toMatchObject({
            _tag: "Fly.ReplicaChecksNotPassing",
          });
        const live = yield* census(initial.appName);
        expect(live.map((machine) => machine.id)).toEqual(initial.machineIds);
        expect(live[0]!.cordoned).toBe(false);
        const fixed = yield* deployWorker(stack, "two", {
          checks: { ready: checks.ready, dependency: checks.ready },
          deploy: { strategy: "bluegreen", healthTimeout: "30 seconds" },
        });
        const committed = yield* assertCommitted(
          initial.appName,
          fixed.machineIds,
        );
        // Active commit metadata can reset reports after readiness validation.
        const healthy = yield* waitHealthy(
          initial.appName,
          committed[0]!,
          30_000,
        );
        expect(healthy.instance_id).toBe(committed[0]!.instance_id);
        expect(
          ["ready", "dependency"].every((name) =>
            healthy.checks?.some(
              (check) => check.name === name && check.status === "passing",
            ),
          ),
        ).toBe(true);
        yield* stack.destroy();
        yield* assertAppGone(initial.appName);
      }),
    { timeout: 300_000 },
  );
}
