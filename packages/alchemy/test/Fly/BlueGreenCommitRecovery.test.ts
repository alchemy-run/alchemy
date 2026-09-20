import * as Fly from "@/Fly";
import { observeReplicaSet } from "@/Fly/replicas";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import { engineActor } from "./fixtures/actors.ts";
import {
  assertAppGone,
  assertCommitted,
  census,
} from "./fixtures/bluegreen.ts";
import {
  makeReadinessControl,
  repairReadiness,
} from "./fixtures/http-readiness-control.ts";
import { transportProxy } from "./fixtures/transport.ts";

const file = "test/Fly/BlueGreenCommitRecovery.test.ts";
const { test } = Test.make({ providers: Fly.providers() });

for (const interrupted of [false, true]) {
  const title = `FLY-REVIEW-1 first-deploy ${interrupted ? "interrupted" : "failed"} final readiness stays pending and cannot shortcut recovery`;
  test.provider(
    title,
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const readiness = yield* makeReadinessControl();
        const site = yield* readiness.deployApp(stack);
        const proxy = yield* transportProxy();
        yield* Effect.sync(() =>
          proxy.arm({
            match: (event) =>
              event.path.endsWith("/metadata") && event.phase === "validating",
            action: "hold-response",
            remaining: 1,
          }),
        );
        const actor = yield* engineActor(stack, title, file, proxy.url);
        const attempt = yield* readiness
          .deployWorker(actor, "one")
          .pipe(Effect.scoped, Effect.result, Effect.forkScoped);
        const barrier = yield* proxy
          .wait(
            (event) =>
              event.stage === "held" &&
              event.phase === "validating" &&
              event.status! >= 200 &&
              event.status! < 300,
          )
          .pipe(
            Effect.raceFirst(
              Effect.gen(function* () {
                const result = yield* Fiber.join(attempt);
                if (Result.isFailure(result))
                  return yield* Effect.fail(result.failure);
                return yield* Effect.fail(
                  new Error(
                    "Deployment completed without reaching the validating barrier",
                  ),
                );
              }),
            ),
          );
        const machineId = barrier.machineId!;
        expect(machineId).toBeDefined();

        const firstRouting = proxy.events.findIndex(
          (event) =>
            event.stage === "request" && event.path.endsWith("/uncordon"),
        );
        expect(firstRouting).toBeGreaterThan(0);
        const preparation = proxy.events.slice(0, firstRouting);
        const promoting = preparation.findLastIndex(
          (event) =>
            event.stage === "completed" &&
            event.phase === "promoting" &&
            event.path.endsWith("/metadata") &&
            event.status! < 300,
        );
        const ready = preparation.findLastIndex(
          (event) =>
            event.stage === "completed" &&
            event.method === "GET" &&
            event.path.endsWith(`/machines/${machineId}`) &&
            event.state === "started" &&
            event.cordoned === true &&
            event.checks?.find((check) => check.name === "ready")?.status ===
              "passing",
        );
        expect(promoting).toBeGreaterThanOrEqual(0);
        expect(ready).toBeGreaterThan(promoting);

        yield* readiness.turnOff(site.appName, machineId);
        if (interrupted) {
          const interruption = yield* Fiber.interrupt(attempt).pipe(
            Effect.forkScoped,
          );
          yield* Effect.yieldNow;
          yield* Effect.sync(proxy.release);
          yield* Fiber.join(interruption).pipe(Effect.timeout("180 seconds"));
          expect(Exit.hasInterrupts(yield* Fiber.await(attempt))).toBe(true);
        } else {
          yield* Effect.sync(proxy.release);
          const result = yield* Fiber.join(attempt).pipe(
            Effect.timeout("180 seconds"),
          );
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result))
            expect(result.failure._tag).toBe("Fly.ReplicaChecksNotPassing");
        }
        yield* Effect.sync(proxy.clear);
        const pending = yield* census(site.appName);
        expect(pending.map((machine) => machine.id)).toEqual([machineId]);
        expect(pending[0]!.cordoned).toBe(false);
        const metadata = pending[0]!.config!.metadata!;
        expect(metadata["alchemy.phase"]).toBe("validating");
        expect(metadata["alchemy.checked-instance"]).toBeUndefined();
        const read = yield* observeReplicaSet({
          appName: site.appName,
          id: "Worker",
          type: "Fly.Machine",
          fqn: metadata["alchemy.fqn"]!,
          resourceInstanceId: metadata["alchemy.instance"]!,
          machineIds: [machineId],
        });
        expect(read?.rolloutPending).toBe(true);
        expect(read?.machineIds).toEqual([]);

        const retryActor = yield* engineActor(stack, title, file, proxy.url);
        const stillBroken = yield* readiness
          .deployWorker(retryActor, "one")
          .pipe(Effect.scoped, Effect.result);
        expect(Result.isFailure(stillBroken)).toBe(true);
        if (Result.isFailure(stillBroken))
          expect(stillBroken.failure._tag).toBe("Fly.ReplicaChecksNotPassing");
        expect(
          (yield* census(site.appName)).map((machine) => machine.id),
        ).toEqual([machineId]);
        expect(
          proxy.events.some(
            (event) =>
              event.phase === "active" && event.path.endsWith("/metadata"),
          ),
        ).toBe(false);

        yield* repairReadiness(site.appName, machineId);
        const recoveryActor = yield* engineActor(stack, title, file, proxy.url);
        const recovered = yield* readiness
          .deployWorker(recoveryActor, "one")
          .pipe(Effect.scoped);
        expect(recovered.machineIds).toEqual([machineId]);
        yield* assertCommitted(site.appName, recovered.machineIds);
        const committed = yield* observeReplicaSet({
          appName: site.appName,
          id: "Worker",
          type: "Fly.Machine",
          fqn: metadata["alchemy.fqn"]!,
          resourceInstanceId: metadata["alchemy.instance"]!,
          machineIds: [machineId],
        });
        expect(committed?.rolloutPending).toBe(false);
        expect(committed?.machineIds).toEqual([machineId]);
        yield* stack.destroy();
        yield* assertAppGone(site.appName);
      }).pipe(Effect.scoped),
    { timeout: 600_000 },
  );
}
