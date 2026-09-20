import * as machines from "@distilled.cloud/fly-io/machines";
import * as Fly from "@/Fly";
import { observeReplicaSet, predecessorShutdown } from "@/Fly/replicas";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import { engineActor } from "./fixtures/actors.ts";
import {
  assertAppGone,
  assertCommitted,
  census,
  deployWorker,
} from "./fixtures/bluegreen.ts";
import {
  observeStops,
  type StopRequest,
  writeLegacyProtocol,
} from "./fixtures/legacy-protocol-writer.ts";
import { transportProxy } from "./fixtures/transport.ts";

const file = "test/Fly/BlueGreenLegacyCompatibility.test.ts";
let endpoint: string | undefined;
let stops: StopRequest[] = [];
const { test } = Test.make({
  providers: observeStops(
    () => endpoint,
    (request) => stops.push(request),
  ),
});

const runningLegacy = (appName: string, id: string) =>
  machines.getMachine({ app_name: appName, machine_id: id }).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      times: 45,
      until: (machine) =>
        machine.state === "started" &&
        machine.config?.metadata?.["alchemy.deployment-protocol"] ===
          undefined &&
        machine.config?.metadata?.["alchemy.generation"] === undefined &&
        machine.config?.stop_config === undefined,
    }),
    Effect.timeout("120 seconds"),
    Effect.tap((machine) =>
      Effect.sync(() => {
        expect(machine.state).toBe("started");
        expect(machine.config?.stop_config).toBeUndefined();
        expect(
          machine.config?.metadata?.["alchemy.deployment-protocol"],
        ).toBeUndefined();
        expect(
          machine.config?.metadata?.["alchemy.generation"],
        ).toBeUndefined();
      }),
    ),
  );

describe.sequential("live legacy protocol compatibility models", () => {
  for (const runtimeTimeoutMs of [undefined, 10_000, 60_000]) {
    test.provider(
      `F14 live legacy missing stop_config ${runtimeTimeoutMs === undefined ? "preserves raw-image defaults" : `uses ${runtimeTimeoutMs}ms runtime-env fallback`}`,
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const site = yield* stack.deploy(Fly.App("Site"));
          try {
            const initial = yield* deployWorker(stack, "one", {
              deploy: { strategy: "rolling" },
              shutdown: undefined,
            });
            yield* writeLegacyProtocol(
              site.appName,
              initial.machineId,
              runtimeTimeoutMs,
            );
            const legacy = yield* runningLegacy(
              site.appName,
              initial.machineId,
            );
            expect(legacy.config?.env?.ALCHEMY_FLY_SHUTDOWN_TIMEOUT_MS).toBe(
              runtimeTimeoutMs?.toString(),
            );
            const policy = yield* predecessorShutdown(legacy);
            if (runtimeTimeoutMs === undefined) {
              expect(policy.signal).toBeUndefined();
              expect(policy.timeout).toBeUndefined();
            } else {
              expect(policy.signal).toBe("SIGTERM");
              expect(policy.timeout).toBe(`${runtimeTimeoutMs}ms`);
              expect(policy.timeoutMs).toBe(runtimeTimeoutMs);
            }
            const proxy = yield* transportProxy();
            yield* Effect.sync(() => {
              endpoint = proxy.url;
              stops = [];
            });
            const upgraded = yield* deployWorker(stack, "two", {
              deploy: { strategy: "bluegreen", healthTimeout: "60 seconds" },
            });
            expect(upgraded.machineId).not.toBe(initial.machineId);
            yield* assertCommitted(site.appName, upgraded.machineIds);
            const stop = stops.filter(
              (request) => request.machineId === initial.machineId,
            );
            expect(stop).toHaveLength(1);
            expect(stop[0]!.signal).toBe(
              runtimeTimeoutMs === undefined ? undefined : "SIGTERM",
            );
            expect(stop[0]!.timeout).toBe(
              runtimeTimeoutMs === undefined
                ? undefined
                : `${runtimeTimeoutMs}ms`,
            );
            expect(
              proxy.events.some(
                (event) =>
                  event.stage === "completed" &&
                  event.machineId === initial.machineId &&
                  event.path.endsWith("/stop") &&
                  event.status! >= 200 &&
                  event.status! < 300,
              ),
            ).toBe(true);
            expect(
              proxy.events.some(
                (event) =>
                  event.stage === "completed" &&
                  event.machineId === initial.machineId &&
                  event.method === "DELETE" &&
                  /\/machines\/[^/]+$/.test(event.path) &&
                  event.status! >= 200 &&
                  event.status! < 300,
              ),
            ).toBe(true);
            const same = yield* deployWorker(stack, "two", {
              deploy: { strategy: "bluegreen", healthTimeout: "65 seconds" },
            });
            expect(same.machineIds).toEqual(upgraded.machineIds);
          } finally {
            yield* Effect.sync(() => {
              endpoint = undefined;
              stops = [];
            });
            yield* stack.destroy();
            yield* assertAppGone(site.appName);
          }
        }).pipe(Effect.scoped),
      { timeout: 900_000 },
    );
  }

  for (const affected of [1, 2]) {
    test.provider(
      `F14 unknown metadata protocol on ${affected} of 2 real Machines safely refuses without mutation`,
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const site = yield* stack.deploy(Fly.App("Site"));
          try {
            const initial = yield* deployWorker(stack, "one", { count: 2 });
            for (const id of initial.machineIds.slice(0, affected)) {
              const target = { app_name: site.appName, machine_id: id };
              const current = yield* machines.getMachine(target);
              yield* machines.updateMachineMetadata({
                ...target,
                metadata: {
                  ...current.config!.metadata,
                  "alchemy.deployment-protocol": "future-unknown",
                },
              });
            }
            const before = yield* census(site.appName);
            expect(
              before.filter(
                (machine) =>
                  machine.config?.metadata?.["alchemy.deployment-protocol"] ===
                  "future-unknown",
              ),
            ).toHaveLength(affected);
            const metadata = before[0]!.config!.metadata!;
            const read = yield* observeReplicaSet({
              appName: site.appName,
              id: "Worker",
              type: "Fly.Machine",
              fqn: metadata["alchemy.fqn"]!,
              resourceInstanceId: metadata["alchemy.instance"]!,
              machineIds: initial.machineIds,
            });
            expect(read?.rolloutPending).toBe(true);
            expect(read?.machineIds).toEqual([]);
            const proxy = yield* transportProxy();
            yield* Effect.sync(() => {
              endpoint = proxy.url;
            });
            const result = yield* deployWorker(stack, "two", { count: 2 }).pipe(
              Effect.timeout("180 seconds"),
              Effect.result,
            );
            expect(Result.isFailure(result)).toBe(true);
            if (Result.isFailure(result)) {
              expect(result.failure).toMatchObject({
                _tag: "Fly.DeploymentRecoveryAmbiguous",
              });
            }
            expect(
              proxy.events.some(
                (event) =>
                  event.stage === "request" &&
                  event.method !== "GET" &&
                  !event.path.endsWith("/lease"),
              ),
            ).toBe(false);
            const after = yield* census(site.appName);
            expect(after.map((machine) => machine.id).sort()).toEqual(
              initial.machineIds.slice().sort(),
            );
            for (const machine of after) {
              const previous = before.find((item) => item.id === machine.id)!;
              expect(machine.instance_id).toBe(previous.instance_id);
              expect(machine.config).toEqual(previous.config);
              expect(machine.cordoned).toBe(false);
              expect(machine.state).toBe("started");
            }
          } finally {
            yield* Effect.sync(() => {
              endpoint = undefined;
            });
            yield* stack.destroy();
            yield* assertAppGone(site.appName);
          }
        }).pipe(Effect.scoped),
      { timeout: 600_000 },
    );
  }

  const partialTitle =
    "F11 F14 partial upgrade with explicit native legacy-protocol writer honors current leases but has no old-binary global fence";
  test.provider(
    partialTitle,
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const site = yield* stack.deploy(Fly.App("Site"));
        try {
          const first = yield* deployWorker(stack, "one", { count: 2 });
          yield* writeLegacyProtocol(
            site.appName,
            first.machineIds[0]!,
            60_000,
          );
          yield* runningLegacy(site.appName, first.machineIds[0]!);
          const mixed = yield* census(site.appName);
          expect(
            mixed.filter(
              (machine) =>
                machine.config?.metadata?.["alchemy.deployment-protocol"] ===
                "1",
            ),
          ).toHaveLength(1);
          expect(
            mixed.filter(
              (machine) =>
                machine.config?.metadata?.["alchemy.deployment-protocol"] ===
                undefined,
            ),
          ).toHaveLength(1);
          const proxy = yield* transportProxy();
          try {
            yield* Effect.sync(() =>
              proxy.arm({
                match: (event) =>
                  event.method === "POST" && event.path.endsWith("/machines"),
                action: "hold-response",
                remaining: 1,
              }),
            );
            yield* Effect.gen(function* () {
              const actor = yield* engineActor(
                stack,
                partialTitle,
                file,
                proxy.url,
              );
              const upgrade = yield* deployWorker(actor, "two", {
                count: 2,
              }).pipe(Effect.scoped, Effect.forkScoped);
              yield* proxy.wait(
                (event) =>
                  event.stage === "held" &&
                  event.status! >= 200 &&
                  event.status! < 300,
              );
              const competing = yield* writeLegacyProtocol(
                site.appName,
                first.machineIds[1]!,
              ).pipe(Effect.result);
              expect(Result.isFailure(competing)).toBe(true);
              if (Result.isFailure(competing))
                expect(competing.failure._tag).toBe("Conflict");
              expect(
                (yield* census(site.appName)).filter((machine) =>
                  first.machineIds.includes(machine.id!),
                ),
              ).toHaveLength(2);
              yield* Effect.sync(() => {
                proxy.clear();
                proxy.release();
              });
              const upgraded = yield* Fiber.join(upgrade).pipe(
                Effect.timeout("300 seconds"),
              );
              yield* assertCommitted(site.appName, upgraded.machineIds);
              // A lease-aware legacy writer can still change a successor after lease release.
              yield* writeLegacyProtocol(
                site.appName,
                upgraded.machineIds[0]!,
                60_000,
              );
              yield* runningLegacy(site.appName, upgraded.machineIds[0]!);
              const partial = yield* census(site.appName);
              expect(partial.map((machine) => machine.id).sort()).toEqual(
                upgraded.machineIds.slice().sort(),
              );
              expect(
                partial.filter(
                  (machine) =>
                    machine.config?.metadata?.[
                      "alchemy.deployment-protocol"
                    ] === undefined,
                ),
              ).toHaveLength(1);
              const resumed = yield* engineActor(stack, partialTitle, file);
              const recovered = yield* deployWorker(resumed, "three", {
                count: 2,
              }).pipe(Effect.scoped);
              expect(
                recovered.machineIds.every(
                  (id) => !upgraded.machineIds.includes(id),
                ),
              ).toBe(true);
              yield* assertCommitted(site.appName, recovered.machineIds);
              yield* Effect.logInfo("Partial-upgrade model boundary", {
                model:
                  "native lease-aware legacy protocol writer, not a literal old binary",
                globalFence: false,
                recoveredCount: recovered.machineIds.length,
              });
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  proxy.clear();
                  proxy.release();
                }),
              ),
              Effect.scoped,
            );
          } finally {
            yield* Effect.sync(() => {
              proxy.clear();
              proxy.release();
            });
          }
        } finally {
          yield* stack.destroy();
          yield* assertAppGone(site.appName);
        }
      }).pipe(Effect.scoped),
    { timeout: 900_000 },
  );
});
