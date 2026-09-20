import * as Fly from "@/Fly";
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

for (const budget of [8_000, 90_000]) {
  test.provider(
    `S06 real delayed readiness beyond the default minute with ${budget}ms budget`,
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const initial = yield* deployWorker(stack, "one");
        const result = yield* deployWorker(stack, "two", {
          init: {
            exec: ["/bin/sh", "-c", "sleep 65; exec nginx -g 'daemon off;'"],
          },
          checks: { ready: { ...checks.ready, gracePeriod: "65s" } },
          deploy: { strategy: "bluegreen", healthTimeout: budget },
        }).pipe(Effect.result);
        if (budget === 8_000) {
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result))
            expect(result.failure).toMatchObject({
              _tag: "Fly.ReplicaChecksNotPassing",
            });
          const live = yield* census(initial.appName);
          expect(live.map((machine) => machine.id)).toEqual(initial.machineIds);
          expect(live[0]!.cordoned).toBe(false);
        } else {
          expect(Result.isSuccess(result)).toBe(true);
          if (Result.isSuccess(result)) {
            expect(result.success.machineId).not.toBe(initial.machineId);
            yield* assertCommitted(initial.appName, result.success.machineIds);
          }
        }
        yield* stack.destroy();
        yield* assertAppGone(initial.appName);
      }),
    { timeout: 600_000 },
  );
}
