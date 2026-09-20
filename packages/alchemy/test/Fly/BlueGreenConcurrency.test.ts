import * as Fly from "@/Fly";
import { waitHealthy } from "@/Fly/replicas";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import {
  assertAppGone,
  assertCommitted,
  census,
  deployWorker,
} from "./fixtures/bluegreen.ts";
import { engineActor } from "./fixtures/actors.ts";
import { transportProxy } from "./fixtures/transport.ts";

const file = "test/Fly/BlueGreenConcurrency.test.ts";
const { test } = Test.make({ providers: Fly.providers() });

const snapshotTitle =
  "F11 an actual delayed Machine-list snapshot cannot retire a newer generation before fresh readiness";
test.provider(
  snapshotTitle,
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const initial = yield* deployWorker(stack, "one");
      const proxy = yield* transportProxy();
      yield* Effect.sync(() =>
        proxy.arm({
          match: (event) =>
            event.method === "GET" && event.path.endsWith("/machines"),
          action: "hold-response",
          remaining: 1,
        }),
      );
      yield* Effect.gen(function* () {
        const staleActor = yield* engineActor(
          stack,
          snapshotTitle,
          file,
          proxy.url,
        );
        const freshActor = yield* engineActor(stack, snapshotTitle, file);
        const delayed = yield* deployWorker(staleActor, "two").pipe(
          Effect.scoped,
          Effect.result,
          Effect.forkScoped,
        );
        yield* proxy.wait(
          (event) => event.stage === "held" && event.status === 200,
        );
        const newer = yield* deployWorker(freshActor, "three");
        expect(newer.machineId).not.toBe(initial.machineId);
        expect(
          proxy.events.some(
            (event) => event.stage === "request" && event.method !== "GET",
          ),
        ).toBe(false);
        yield* Effect.sync(proxy.release);
        const result = yield* Fiber.join(delayed).pipe(
          Effect.timeout("180 seconds"),
        );
        if (Result.isSuccess(result)) {
          // A later valid reconcile may win; native leases do not fence LocalState with a global epoch.
          yield* assertCommitted(initial.appName, result.success.machineIds);
          for (const id of newer.machineIds) {
            const retire = proxy.events.findIndex(
              (event) =>
                event.stage === "request" &&
                event.machineId === id &&
                (event.path.endsWith("/stop") ||
                  event.path.endsWith("/cordon") ||
                  (event.method === "DELETE" &&
                    !event.path.endsWith("/lease"))),
            );
            expect(retire).toBeGreaterThan(0);
            for (const candidate of result.success.machineIds) {
              expect(
                proxy.events
                  .slice(0, retire)
                  .some(
                    (event) =>
                      event.stage === "completed" &&
                      event.machineId === candidate &&
                      event.method === "GET" &&
                      event.state === "started" &&
                      event.checks?.some(
                        (check) =>
                          check.name === "ready" && check.status === "passing",
                      ),
                  ),
              ).toBe(true);
            }
          }
        } else {
          expect([
            "Fly.DeploymentRecoveryAmbiguous",
            "Fly.ReplicaOwnershipChanged",
            "Fly.MachineLeaseBusy",
            "Fly.MachineLeaseLost",
            "NotFound",
          ]).toContain(result.failure._tag);
          expect(
            (yield* census(initial.appName)).some(
              (machine) => machine.id === newer.machineId,
            ),
          ).toBe(true);
          yield* Effect.logInfo(
            "Stale snapshot refused without state-fencing guarantee",
            { outcome: result.failure._tag },
          );
        }
        const resumed = yield* engineActor(stack, snapshotTitle, file);
        const settled = yield* deployWorker(resumed, "four");
        yield* assertCommitted(initial.appName, settled.machineIds);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            proxy.clear();
            proxy.release();
          }),
        ),
        Effect.scoped,
      );
      yield* stack.destroy();
      yield* assertAppGone(initial.appName);
    }).pipe(Effect.scoped),
  { timeout: 600_000 },
);

describe.sequential("independent engine contexts", () => {
  for (const competitor of ["bluegreen", "rolling", "destroy"] as const) {
    const title = `F11 shared-old lease excludes ${competitor} while a candidate response is held`;
    test.provider(
      title,
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const initial = yield* deployWorker(stack, "one");
          const holderProxy = yield* transportProxy();
          const contenderProxy = yield* transportProxy();
          yield* Effect.sync(() =>
            holderProxy.arm({
              match: (event) =>
                event.method === "POST" && event.path.endsWith("/machines"),
              action: "hold-response",
              remaining: 1,
            }),
          );
          yield* Effect.gen(function* () {
            const holderActor = yield* engineActor(
              stack,
              title,
              file,
              holderProxy.url,
            );
            const contenderActor = yield* engineActor(
              stack,
              title,
              file,
              contenderProxy.url,
            );
            expect(contenderActor.state).not.toBe(holderActor.state);
            const holder = yield* deployWorker(holderActor, "two").pipe(
              Effect.scoped,
              Effect.forkScoped,
            );
            const held = yield* holderProxy.wait(
              (event) => event.stage === "held" && event.status! < 300,
            );
            const operation =
              competitor === "destroy"
                ? contenderActor.destroy()
                : deployWorker(contenderActor, "three", {
                    deploy: {
                      strategy: competitor,
                      healthTimeout: "30 seconds",
                    },
                  }).pipe(Effect.asVoid);
            const result = yield* operation.pipe(
              Effect.scoped,
              Effect.timeout("75 seconds"),
              Effect.result,
            );
            yield* Effect.sync(holderProxy.release);
            expect(Result.isFailure(result)).toBe(true);
            if (Result.isFailure(result))
              expect(result.failure).not.toMatchObject({
                _tag: "TimeoutError",
              });
            expect(
              contenderProxy.events.some(
                (event) =>
                  event.stage === "completed" &&
                  event.status === 409 &&
                  event.path.endsWith("/lease") &&
                  event.machineId === initial.machineId,
              ),
            ).toBe(true);
            expect(
              contenderProxy.events.some(
                (event) =>
                  event.stage === "completed" &&
                  event.status! < 300 &&
                  event.method !== "GET" &&
                  !event.path.endsWith("/lease"),
              ),
            ).toBe(false);
            const next = yield* Fiber.join(holder).pipe(
              Effect.timeout("90 seconds"),
            );
            expect(next.machineIds).toEqual([held.machineId]);
            expect(
              (yield* census(initial.appName)).map((machine) => machine.id),
            ).toEqual(next.machineIds);
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                holderProxy.clear();
                holderProxy.release();
              }),
            ),
            Effect.scoped,
          );
          yield* stack.destroy();
          yield* assertAppGone(initial.appName);
        }).pipe(Effect.scoped),
      { timeout: 300_000 },
    );
  }

  const title =
    "S02 F11 concurrent first Machine engine deployments preserve ownership without assuming a global lock";
  test.provider(
    title,
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const app = yield* stack.deploy(Fly.App("Site"));
        const firstProxy = yield* transportProxy();
        const secondProxy = yield* transportProxy();
        yield* Effect.sync(() =>
          firstProxy.arm({
            match: (event) =>
              event.method === "POST" && event.path.endsWith("/machines"),
            action: "hold-response",
            remaining: 1,
          }),
        );
        yield* Effect.gen(function* () {
          const firstActor = yield* engineActor(
            stack,
            title,
            file,
            firstProxy.url,
          );
          const secondActor = yield* engineActor(
            stack,
            title,
            file,
            secondProxy.url,
          );
          const first = yield* deployWorker(firstActor, "one").pipe(
            Effect.scoped,
            Effect.result,
            Effect.forkScoped,
          );
          const created = yield* firstProxy.wait(
            (event) => event.stage === "held" && event.status! < 300,
          );
          const original = (yield* census(app.appName)).find(
            (machine) => machine.id === created.machineId,
          );
          const owner = original?.config?.metadata;
          expect(owner?.["alchemy.fqn"]).toBeTruthy();
          expect(owner?.["alchemy.instance"]).toBeTruthy();
          expect(
            firstProxy.events.some(
              (event) =>
                event.stage === "completed" &&
                event.method === "POST" &&
                event.path.endsWith("/lease") &&
                event.status! < 300,
            ),
          ).toBe(false);
          const second = yield* deployWorker(secondActor, "two").pipe(
            Effect.scoped,
            Effect.timeout("90 seconds"),
            Effect.result,
          );
          const during = yield* census(app.appName);
          yield* Effect.sync(firstProxy.release);
          const firstResult = yield* Fiber.join(first).pipe(
            Effect.timeout("90 seconds"),
          );
          yield* Effect.logInfo(
            "First-deploy results: no global exclusion promised",
            {
              first: Result.isFailure(firstResult)
                ? firstResult.failure._tag
                : firstResult._tag,
              second: Result.isFailure(second)
                ? second.failure._tag
                : second._tag,
            },
          );
          const successfulIds: string[] = [];
          for (const result of [firstResult, second]) {
            if (Result.isSuccess(result)) {
              expect(result.success.machineIds.length).toBe(1);
              successfulIds.push(...result.success.machineIds);
            } else {
              expect([
                "Fly.DeploymentRecoveryAmbiguous",
                "Fly.ReplicaOwnershipChanged",
                "Fly.MachineLeaseBusy",
                "Fly.MachineLeaseLost",
                "Fly.MachineNotCreated",
                "NotFound",
              ]).toContain(result.failure._tag);
            }
          }
          expect(successfulIds.length).toBeGreaterThan(0);
          // A held create response conveys no lease; a leased, ready successor may retire it.
          if (Result.isSuccess(second)) {
            const committed = yield* assertCommitted(
              app.appName,
              second.success.machineIds,
            );
            for (const machine of committed) {
              yield* waitHealthy(app.appName, machine, 30_000, machine.config);
            }
            expect(during.map((machine) => machine.id).sort()).toEqual(
              [...second.success.machineIds].sort(),
            );
            expect(
              during.every(
                (machine) =>
                  machine.state === "started" &&
                  machine.cordoned === false &&
                  machine.config?.metadata?.["alchemy.phase"] === "active",
              ),
            ).toBe(true);
          } else {
            expect(
              during.some((machine) => machine.id === created.machineId),
            ).toBe(true);
          }
          const createdIds = new Set(
            [firstProxy, secondProxy].flatMap((proxy) =>
              proxy.events
                .filter(
                  (event) =>
                    event.stage === "completed" &&
                    event.method === "POST" &&
                    event.path.endsWith("/machines") &&
                    event.status! < 300,
                )
                .map((event) => event.machineId),
            ),
          );
          for (const proxy of [firstProxy, secondProxy]) {
            for (const [index, event] of proxy.events.entries()) {
              if (
                event.stage !== "request" ||
                !(
                  event.path.endsWith("/stop") ||
                  event.path.endsWith("/cordon") ||
                  event.phase === "retiring" ||
                  (event.method === "DELETE" &&
                    /\/machines\/[^/]+$/.test(event.path))
                )
              )
                continue;
              expect(event.machineId).toBeDefined();
              expect(createdIds.has(event.machineId)).toBe(true);
              const before = proxy.events.slice(0, index);
              const lease = before.findIndex(
                (prior) =>
                  prior.stage === "completed" &&
                  prior.machineId === event.machineId &&
                  prior.method === "POST" &&
                  prior.path.endsWith("/lease") &&
                  prior.status! < 300,
              );
              expect(lease).toBeGreaterThan(-1);
              expect(
                before
                  .slice(lease + 1)
                  .some(
                    (prior) =>
                      prior.stage === "completed" &&
                      prior.machineId === event.machineId &&
                      prior.method === "GET" &&
                      /\/machines\/[^/]+$/.test(prior.path) &&
                      prior.status === 200,
                  ),
              ).toBe(true);
              expect(
                before.some(
                  (ready, readyIndex) =>
                    ready.stage === "completed" &&
                    ready.method === "GET" &&
                    ready.status === 200 &&
                    ready.machineId !== event.machineId &&
                    createdIds.has(ready.machineId) &&
                    ready.state === "started" &&
                    ready.cordoned === false &&
                    ready.checks?.some(
                      (check) =>
                        check.name === "ready" && check.status === "passing",
                    ) &&
                    before
                      .slice(readyIndex + 1)
                      .some(
                        (active) =>
                          active.stage === "completed" &&
                          active.machineId === ready.machineId &&
                          active.method === "PUT" &&
                          active.phase === "active" &&
                          active.status! < 300,
                      ),
                ),
              ).toBe(true);
            }
          }
          const live = yield* census(app.appName);
          expect(live.length).toBe(1);
          expect(
            live.every(
              (machine) =>
                successfulIds.includes(machine.id!) &&
                machine.state === "started" &&
                machine.cordoned === false &&
                machine.checks?.some(
                  (check) =>
                    check.name === "ready" && check.status === "passing",
                ) &&
                machine.config?.metadata?.["alchemy.fqn"] ===
                  owner?.["alchemy.fqn"] &&
                machine.config?.metadata?.["alchemy.instance"] ===
                  owner?.["alchemy.instance"],
            ),
          ).toBe(true);
          yield* assertCommitted(
            app.appName,
            live.map((machine) => machine.id!),
          );
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              firstProxy.clear();
              firstProxy.release();
            }),
          ),
          Effect.scoped,
        );
        yield* stack.destroy();
        yield* assertAppGone(app.appName);
      }).pipe(Effect.scoped),
    { timeout: 300_000 },
  );
});
