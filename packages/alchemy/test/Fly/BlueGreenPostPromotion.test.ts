import { observeReplicaSet } from "@/Fly/replicas";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import {
  assertAppGone,
  assertCommitted,
  census,
} from "./fixtures/bluegreen.ts";
import {
  makeReadinessControl,
  repairReadiness,
} from "./fixtures/http-readiness-control.ts";
import { throughProxy, transportProxy } from "./fixtures/transport.ts";

let endpoint: string | undefined;
const { test } = Test.make({ providers: throughProxy(() => endpoint) });

describe.sequential("post-promotion health", () => {
  for (const changed of [false, true]) {
    test.provider(
      `F09 a real post-uncordon health flip preserves both generations then recovers ${changed ? "changed" : "same"} desired state`,
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const readiness = yield* makeReadinessControl();
          const initial = yield* readiness.deployWorker(stack, "one");
          const proxy = yield* transportProxy();
          yield* Effect.sync(() => {
            endpoint = proxy.url;
            proxy.arm({
              match: (event) => event.path.endsWith("/uncordon"),
              action: "hold-response",
              remaining: 1,
            });
          });
          const update = yield* readiness
            .deployWorker(stack, "two")
            .pipe(Effect.result, Effect.forkScoped);
          const promoted = yield* proxy.wait(
            (event) =>
              event.stage === "held" &&
              event.path.endsWith("/uncordon") &&
              event.status! < 300,
          );
          expect(promoted.machineId).toBeDefined();
          yield* readiness.turnOff(initial.appName, promoted.machineId!);
          yield* Effect.sync(proxy.release);
          const result = yield* Fiber.join(update).pipe(
            Effect.timeout("60 seconds"),
          );
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result))
            expect(result.failure).toMatchObject({
              _tag: "Fly.ReplicaChecksNotPassing",
            });
          const live = yield* census(initial.appName);
          expect(live.map((machine) => machine.id).sort()).toEqual(
            [initial.machineId, promoted.machineId!].sort(),
          );
          expect(live.every((machine) => machine.cordoned === false)).toBe(
            true,
          );
          const pending = live.find(
            (machine) => machine.id === promoted.machineId,
          )!;
          const metadata = pending.config!.metadata!;
          expect(metadata["alchemy.phase"]).toBe("validating");
          expect(metadata["alchemy.checked-instance"]).toBeUndefined();
          const read = yield* observeReplicaSet({
            appName: initial.appName,
            id: "Worker",
            type: "Fly.Machine",
            fqn: metadata["alchemy.fqn"]!,
            resourceInstanceId: metadata["alchemy.instance"]!,
            machineIds: initial.machineIds,
          });
          expect(read?.machineIds).toEqual(initial.machineIds);
          expect(read?.rolloutPending).toBe(true);
          expect(
            proxy.events.some(
              (event) =>
                event.method === "DELETE" &&
                /\/machines\/[^/]+$/.test(event.path),
            ),
          ).toBe(false);
          if (!changed) {
            yield* repairReadiness(initial.appName, promoted.machineId!);
          }
          const recovered = yield* readiness.deployWorker(
            stack,
            changed ? "three" : "two",
          );
          if (changed) expect(recovered.machineId).not.toBe(promoted.machineId);
          else expect(recovered.machineId).toBe(promoted.machineId);
          yield* assertCommitted(initial.appName, recovered.machineIds);
          yield* Effect.sync(() => {
            endpoint = undefined;
          });
          yield* stack.destroy();
          yield* assertAppGone(initial.appName);
        }).pipe(
          Effect.scoped,
          Effect.ensuring(
            Effect.sync(() => {
              endpoint = undefined;
            }),
          ),
        ),
      { timeout: 300_000 },
    );
  }
});
