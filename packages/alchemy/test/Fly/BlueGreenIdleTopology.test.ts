import * as machines from "@distilled.cloud/fly-io/machines";
import * as Fly from "@/Fly";
import type { MachineProps } from "@/Fly/Machine";
import { autostopMode, observeReplicaSet } from "@/Fly/replicas";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import {
  assertReadinessCommit,
  readinessActor,
  readinessChecksPassing,
  readinessProxy,
  retires,
  type ReadinessEvent,
} from "./fixtures/idle-cadence-readiness.ts";
import {
  assertAppGone,
  assertCommitted,
  census,
  checks,
  deployWorker,
} from "./fixtures/bluegreen.ts";
import type { TransportEvent } from "./fixtures/transport.ts";

const file = "test/Fly/BlueGreenIdleTopology.test.ts";
const { test } = Test.make({ providers: Fly.providers() });
type IdleMode = "stop" | "suspend";

const topology = (
  mode: IdleMode,
  count: number,
  floor = 0,
  mixed = false,
): Partial<Omit<MachineProps, "app">> => ({
  count,
  deploy: { strategy: "bluegreen", healthTimeout: "60 seconds" },
  services: [
    {
      protocol: "tcp",
      internalPort: 80,
      autostop: mode,
      autostart: true,
      minMachinesRunning: floor,
      checks: [checks.ready],
    },
    ...(mixed
      ? [{ protocol: "tcp", internalPort: 81, autostop: "off" as const }]
      : []),
  ],
});

const waitState = (appName: string, machineId: string, state: string) =>
  machines.getMachine({ app_name: appName, machine_id: machineId }).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      times: 30,
      until: (machine) => machine.state === state,
    }),
    Effect.tap((machine) =>
      Effect.sync(() => expect(machine.state).toBe(state)),
    ),
    Effect.timeout("90 seconds"),
  );

// Native stop/suspend is setup only; automatic return-to-idle has its own test.
const idleAll = (appName: string, ids: string[], mode: IdleMode) =>
  Effect.forEach(ids, (id) =>
    Effect.gen(function* () {
      const target = { app_name: appName, machine_id: id };
      const current = yield* machines.getMachine(target);
      if (current.state !== "started") {
        yield* machines.startMachine(target);
        yield* waitState(appName, id, "started");
      }
      if (mode === "stop") {
        yield* machines.stopMachine({
          ...target,
          signal: "SIGQUIT",
          timeout: "5s",
        });
      } else {
        yield* machines.suspendMachine(target);
      }
      yield* waitState(appName, id, mode === "stop" ? "stopped" : "suspended");
    }),
  );

// Expected slots are literal scenario inputs, never computed by readinessRoles.
const assertSlots = (
  live: machines.Machine[],
  runningSlots: readonly number[],
) => {
  const ordered = [...live].sort(
    (left, right) =>
      Number(left.config?.metadata?.["alchemy.replica"]) -
      Number(right.config?.metadata?.["alchemy.replica"]),
  );
  expect(
    ordered.map((machine) => machine.config?.metadata?.["alchemy.replica"]),
  ).toEqual(Array.from({ length: live.length }, (_, index) => String(index)));
  expect(
    ordered
      .filter(
        (machine) =>
          machine.config?.metadata?.["alchemy.readiness-role"] === "run",
      )
      .map((machine) => Number(machine.config?.metadata?.["alchemy.replica"])),
  ).toEqual([...runningSlots]);
  const roles = Array.from({ length: live.length }, (_, slot) =>
    runningSlots.includes(slot) ? "run" : "idle",
  ).join(",");
  for (const [slot, machine] of ordered.entries()) {
    expect(machine.config?.metadata?.["alchemy.readiness-role"]).toBe(
      runningSlots.includes(slot) ? "run" : "idle",
    );
    expect(machine.config?.metadata?.["alchemy.readiness-roles"]).toBe(roles);
  }
  return ordered;
};

const assertTopology = (
  appName: string,
  ids: string[],
  mode: IdleMode,
  runningSlots: readonly number[],
  floor = 0,
  mixed = false,
) =>
  Effect.gen(function* () {
    const live = yield* assertCommitted(appName, ids);
    const ordered = assertSlots(live, runningSlots);
    expect(
      new Set(
        live.map((machine) => machine.config?.metadata?.["alchemy.generation"]),
      ).size,
    ).toBe(1);
    for (const [slot, machine] of ordered.entries()) {
      expect(machine.config?.metadata?.["alchemy.idle-policy-restored"]).toBe(
        "true",
      );
      expect(machine.cordoned).toBe(false);
      expect(machine.config?.services).toHaveLength(mixed ? 2 : 1);
      expect(autostopMode(machine.config?.services?.[0]?.autostop)).toBe(mode);
      expect(machine.config?.services?.[0]?.autostart).toBe(true);
      expect(machine.config?.services?.[0]?.min_machines_running).toBe(floor);
      if (mixed) {
        expect(autostopMode(machine.config?.services?.[1]?.autostop)).toBe(
          "off",
        );
      }
      if (!runningSlots.includes(slot)) {
        expect(["created", "stopped", "suspended"]).toContain(machine.state);
      } else {
        expect(
          mixed ? ["started"] : ["started", "stopped", "suspended"],
        ).toContain(machine.state);
        expect(machine.instance_id).toBeDefined();
        expect(machine.config?.metadata?.["alchemy.checked-instance"]).toBe(
          machine.instance_id,
        );
      }
    }
    return ordered;
  });

const checkedDeployment = (
  actor: Test.ScratchStack,
  proxy: { events: TransportEvent[]; readiness: ReadinessEvent[] },
  version: string,
  mode: IdleMode,
  count: number,
  runningSlots: readonly number[],
  priorIds: readonly string[] = [],
  floor = 0,
  mixed = false,
) =>
  Effect.gen(function* () {
    const begin = proxy.events.length;
    const proofBegin = proxy.readiness.length;
    const output = yield* deployWorker(
      actor,
      version,
      topology(mode, count, floor, mixed),
    ).pipe(Effect.scoped);
    const live = yield* assertTopology(
      output.appName,
      output.machineIds,
      mode,
      runningSlots,
      floor,
      mixed,
    );
    assertReadinessCommit(
      proxy.readiness.slice(proofBegin),
      priorIds,
      live,
      runningSlots,
      ["ready", "servicecheck-00-http-80"],
      !mixed,
    );
    expect(
      proxy.events
        .slice(begin)
        .some(
          (event) =>
            event.stage === "request" &&
            priorIds.includes(event.machineId!) &&
            event.path.endsWith("/start"),
        ),
    ).toBe(false);
    return output;
  });

describe.sequential("live idle topology and automatic cadence", () => {
  for (const mode of ["stop", "suspend"] as const) {
    const scaleTitle = `S05 S11 F13 ${mode} real all-idle 1 to 3 to 1 scaling preserves representative-only readiness`;
    test.provider(
      scaleTitle,
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const site = yield* stack.deploy(Fly.App("Site"));
          try {
            const proxy = yield* readinessProxy();
            const actor = yield* readinessActor(stack, scaleTitle, file, proxy);
            const first = yield* checkedDeployment(
              actor,
              proxy,
              "one",
              mode,
              1,
              [0],
            );
            yield* idleAll(site.appName, first.machineIds, mode);
            const up = yield* checkedDeployment(
              actor,
              proxy,
              "two",
              mode,
              3,
              [0],
              first.machineIds,
            );
            expect(up.machineIds).toHaveLength(3);
            expect(
              up.machineIds.every((id) => !first.machineIds.includes(id)),
            ).toBe(true);
            yield* idleAll(site.appName, up.machineIds, mode);
            const down = yield* checkedDeployment(
              actor,
              proxy,
              "three",
              mode,
              1,
              [0],
              up.machineIds,
            );
            expect(down.machineIds).toHaveLength(1);
            expect(up.machineIds).not.toContain(down.machineId);
            yield* idleAll(site.appName, down.machineIds, mode);
            const unchanged = yield* deployWorker(
              actor,
              "three",
              topology(mode, 1),
            );
            expect(unchanged.machineIds).toEqual(down.machineIds);
            expect((yield* census(site.appName))[0]!.state).toBe(
              mode === "stop" ? "stopped" : "suspended",
            );
          } finally {
            yield* stack.destroy();
            yield* assertAppGone(site.appName);
          }
        }).pipe(Effect.scoped),
      { timeout: 900_000 },
    );

    const floorTitle = `S05 S11 F13 ${mode} live floor 0 to 2 to 0 and mixed off-plus-idle service topology`;
    test.provider(
      floorTitle,
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const site = yield* stack.deploy(Fly.App("Site"));
          try {
            const proxy = yield* readinessProxy();
            const actor = yield* readinessActor(stack, floorTitle, file, proxy);
            const first = yield* checkedDeployment(
              actor,
              proxy,
              "one",
              mode,
              3,
              [0],
            );
            yield* idleAll(site.appName, first.machineIds, mode);
            const raised = yield* checkedDeployment(
              actor,
              proxy,
              "one",
              mode,
              3,
              [0, 1],
              first.machineIds,
              2,
            );
            yield* idleAll(site.appName, raised.machineIds, mode);
            const lowered = yield* checkedDeployment(
              actor,
              proxy,
              "one",
              mode,
              3,
              [0],
              raised.machineIds,
            );
            yield* idleAll(site.appName, lowered.machineIds, mode);
            const slots = assertSlots(yield* census(site.appName), [0]);
            yield* machines.startMachine({
              app_name: site.appName,
              machine_id: slots[2]!.id!,
            });
            yield* waitState(site.appName, slots[2]!.id!, "started");
            const mixedOld = (yield* census(site.appName)).sort(
              (a, b) =>
                Number(a.config?.metadata?.["alchemy.replica"]) -
                Number(b.config?.metadata?.["alchemy.replica"]),
            );
            expect(mixedOld.map((machine) => machine.state)).toEqual([
              mode === "stop" ? "stopped" : "suspended",
              mode === "stop" ? "stopped" : "suspended",
              "started",
            ]);
            const retained = yield* checkedDeployment(
              actor,
              proxy,
              "retained",
              mode,
              3,
              [2],
              lowered.machineIds,
            );
            yield* idleAll(site.appName, retained.machineIds, mode);
            const retainedSlots = assertSlots(yield* census(site.appName), [2]);
            yield* machines.startMachine({
              app_name: site.appName,
              machine_id: retainedSlots[2]!.id!,
            });
            yield* waitState(site.appName, retainedSlots[2]!.id!, "started");
            expect(
              assertSlots(yield* census(site.appName), [2]).map(
                (machine) => machine.state,
              ),
            ).toEqual([
              mode === "stop" ? "stopped" : "suspended",
              mode === "stop" ? "stopped" : "suspended",
              "started",
            ]);
            const retainedFloor = yield* checkedDeployment(
              actor,
              proxy,
              "retained",
              mode,
              3,
              [0, 2],
              retained.machineIds,
              2,
            );
            yield* idleAll(site.appName, retainedFloor.machineIds, mode);
            const mixed = yield* checkedDeployment(
              actor,
              proxy,
              "one",
              mode,
              3,
              [0, 1, 2],
              retainedFloor.machineIds,
              0,
              true,
            );
            yield* idleAll(site.appName, mixed.machineIds, mode);
            yield* checkedDeployment(
              actor,
              proxy,
              "one",
              mode,
              3,
              [0],
              mixed.machineIds,
            );
          } finally {
            yield* stack.destroy();
            yield* assertAppGone(site.appName);
          }
        }).pipe(Effect.scoped),
      { timeout: 1_200_000 },
    );

    for (const recoveredCount of [3, 1, 4]) {
      const title = `S05 S11 F08 F13 ${mode} interrupted partial idle restoration recovers count 3 to ${recoveredCount}`;
      test.provider(
        title,
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const site = yield* stack.deploy(Fly.App("Site"));
            try {
              const proxy = yield* readinessProxy();
              const initial = yield* readinessActor(stack, title, file, proxy);
              const first = yield* checkedDeployment(
                initial,
                proxy,
                "one",
                mode,
                3,
                [0],
              );
              yield* idleAll(site.appName, first.machineIds, mode);
              const source = (yield* census(site.appName))[0]!;
              const metadata = source.config!.metadata!;
              const attemptBegin = proxy.events.length;
              yield* Effect.gen(function* () {
                try {
                  const gate = yield* Deferred.make<string>();
                  const actor = yield* readinessActor(
                    stack,
                    title,
                    file,
                    proxy,
                    (event) =>
                      event.method === "POST" &&
                      event.path ===
                        `/v1/apps/${site.appName}/machines/${event.machineId}` &&
                      event.metadata?.["alchemy.replica"] === "1" &&
                      event.metadata["alchemy.fqn"] ===
                        metadata["alchemy.fqn"] &&
                      event.metadata["alchemy.generation"] !==
                        metadata["alchemy.generation"] &&
                      event.metadata["alchemy.readiness-roles"] ===
                        "run,run,idle" &&
                      event.metadata["alchemy.idle-policy-restored"] ===
                        "true" &&
                      event.phase === "promoting"
                        ? Deferred.succeed(gate, event.machineId!).pipe(
                            Effect.andThen(Effect.never),
                          )
                        : Effect.void,
                  );
                  const attempt = yield* deployWorker(
                    actor,
                    "two",
                    topology(mode, 3, 2),
                  ).pipe(Effect.scoped, Effect.forkScoped);
                  const barrierMachine = yield* Deferred.await(gate).pipe(
                    Effect.timeout("180 seconds"),
                  );
                  const pending = yield* census(site.appName);
                  expect(
                    pending.filter((machine) =>
                      first.machineIds.includes(machine.id!),
                    ),
                  ).toHaveLength(3);
                  expect(
                    proxy.events.some((event) =>
                      retires(event, first.machineIds),
                    ),
                  ).toBe(false);
                  const candidates = yield* Effect.forEach(
                    pending.filter(
                      (machine) => !first.machineIds.includes(machine.id!),
                    ),
                    (machine) =>
                      machines.getMachine({
                        app_name: site.appName,
                        machine_id: machine.id!,
                      }),
                  );
                  expect(candidates).toHaveLength(3);
                  expect(
                    candidates.every(
                      (machine) =>
                        machine.config?.metadata?.["alchemy.phase"] ===
                        "promoting",
                    ),
                  ).toBe(true);
                  const pendingSlots = assertSlots(candidates, [0, 1]);
                  expect(
                    pendingSlots[0]!.config?.metadata?.[
                      "alchemy.idle-policy-restored"
                    ],
                  ).toBe("true");
                  expect(
                    pendingSlots[1]!.config?.metadata?.[
                      "alchemy.idle-policy-restored"
                    ],
                  ).toBe("false");
                  expect(
                    proxy.readiness.some(
                      (event) =>
                        event.stage === "forwarded" &&
                        event.method === "GET" &&
                        event.machineId === pendingSlots[0]!.id &&
                        event.instanceId === pendingSlots[0]!.instance_id &&
                        event.metadata?.["alchemy.idle-policy-restored"] ===
                          "true" &&
                        event.phase === "promoting" &&
                        event.state === "started" &&
                        readinessChecksPassing(event.checks, [
                          "ready",
                          "servicecheck-00-http-80",
                        ]),
                    ),
                  ).toBe(true);
                  expect(barrierMachine).toBe(pendingSlots[1]!.id);
                  expect(
                    autostopMode(
                      pendingSlots[0]!.config?.services?.[0]?.autostop,
                    ),
                  ).toBe(mode);
                  expect(
                    autostopMode(
                      pendingSlots[1]!.config?.services?.[0]?.autostop,
                    ),
                  ).toBe("off");
                  expect(
                    proxy.events
                      .slice(attemptBegin)
                      .some(
                        (event) =>
                          event.method === "POST" &&
                          event.path.endsWith(`/machines/${barrierMachine}`) &&
                          event.phase === "promoting",
                      ),
                  ).toBe(false);
                  const read = yield* observeReplicaSet({
                    appName: site.appName,
                    id: "Worker",
                    type: "Fly.Machine",
                    fqn: metadata["alchemy.fqn"]!,
                    resourceInstanceId: metadata["alchemy.instance"]!,
                    baseName: first.baseName,
                    machineIds: first.machineIds,
                  });
                  expect(read?.machineIds).toEqual(first.machineIds);
                  expect(read?.count).toBe(3);
                  expect(read?.rolloutPending).toBe(true);
                  const interruption = yield* Fiber.interrupt(attempt).pipe(
                    Effect.forkScoped,
                  );
                  yield* Effect.yieldNow;
                  yield* Effect.sync(() => {
                    proxy.clear();
                    proxy.release();
                  });
                  yield* Fiber.join(interruption).pipe(
                    Effect.timeout("180 seconds"),
                  );
                  expect(Exit.hasInterrupts(yield* Fiber.await(attempt))).toBe(
                    true,
                  );
                  expect(
                    proxy.events
                      .slice(attemptBegin)
                      .some(
                        (event) =>
                          first.machineIds.includes(event.machineId!) &&
                          event.path.endsWith("/start"),
                      ),
                  ).toBe(false);
                  expect(
                    proxy.readiness.some(
                      (event) =>
                        event.stage === "request" &&
                        event.path.endsWith("/metadata") &&
                        event.phase === "active" &&
                        candidates.some(
                          (machine) => machine.id === event.machineId,
                        ),
                    ),
                  ).toBe(false);
                  expect(
                    proxy.events.some((event) =>
                      retires(event, first.machineIds),
                    ),
                  ).toBe(false);
                  const resumed = yield* readinessActor(
                    stack,
                    title,
                    file,
                    proxy,
                  );
                  const begin = proxy.readiness.length;
                  const recovered = yield* deployWorker(
                    resumed,
                    "two",
                    topology(mode, recoveredCount, 2),
                  ).pipe(Effect.scoped);
                  expect(recovered.machineIds).toHaveLength(recoveredCount);
                  if (recoveredCount === 3) {
                    expect([...recovered.machineIds].sort()).toEqual(
                      candidates.map((machine) => machine.id).sort(),
                    );
                  } else {
                    expect(
                      recovered.machineIds.every(
                        (id) => !pending.some((machine) => machine.id === id),
                      ),
                    ).toBe(true);
                  }
                  const runningSlots = recoveredCount === 1 ? [0] : [0, 1];
                  const live = yield* assertTopology(
                    site.appName,
                    recovered.machineIds,
                    mode,
                    runningSlots,
                    2,
                  );
                  assertReadinessCommit(
                    proxy.readiness.slice(begin),
                    pending
                      .map((machine) => machine.id!)
                      .filter((id) => !recovered.machineIds.includes(id)),
                    live,
                    runningSlots,
                    ["ready", "servicecheck-00-http-80"],
                    true,
                  );
                  const unchanged = yield* deployWorker(
                    resumed,
                    "two",
                    topology(mode, recoveredCount, 2),
                  ).pipe(Effect.scoped);
                  expect(unchanged.machineIds).toEqual(recovered.machineIds);
                  const committed = yield* observeReplicaSet({
                    appName: site.appName,
                    id: "Worker",
                    type: "Fly.Machine",
                    fqn: metadata["alchemy.fqn"]!,
                    resourceInstanceId: metadata["alchemy.instance"]!,
                    machineIds: recovered.machineIds,
                  });
                  expect(committed?.rolloutPending).toBe(false);
                  expect(committed?.machineIds).toEqual(recovered.machineIds);
                } finally {
                  yield* Effect.sync(() => {
                    proxy.clear();
                    proxy.release();
                  });
                }
              }).pipe(Effect.scoped);
            } finally {
              yield* stack.destroy();
              yield* assertAppGone(site.appName);
            }
          }).pipe(Effect.scoped),
        { timeout: 900_000 },
      );
    }

    const trafficTitle = `S11 public traffic autostarts ${mode} and Fly automatically returns it to idle within 15 minutes`;
    test.provider(
      trafficTitle,
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const site = yield* stack.deploy(Fly.App("Site"));
          try {
            const output = yield* stack.deploy(
              Effect.gen(function* () {
                const app = yield* Fly.App("Site");
                yield* Fly.IpAssignment("Public", { app, type: "shared_v4" });
                return yield* Fly.Machine("Worker", {
                  app,
                  image: "nginx:alpine",
                  deploy: {
                    strategy: "bluegreen",
                    healthTimeout: "60 seconds",
                  },
                  shutdown: { signal: "SIGQUIT", timeout: "5 seconds" },
                  services: [
                    {
                      protocol: "tcp",
                      internalPort: 80,
                      autostop: mode,
                      autostart: true,
                      minMachinesRunning: 0,
                      ports: [{ port: 80, handlers: ["http"] }],
                      checks: [checks.ready],
                    },
                  ],
                });
              }),
            );
            yield* idleAll(site.appName, output.machineIds, mode);
            const client = yield* HttpClient.HttpClient;
            yield* Effect.gen(function* () {
              const response = yield* client.get(
                `http://${site.appName}.fly.dev`,
              );
              const body = yield* response.text;
              if (
                response.status !== 200 ||
                !body.includes("Welcome to nginx")
              ) {
                return yield* Effect.fail(
                  new Error(
                    `Public Fly route is not ready: ${response.status}`,
                  ),
                );
              }
              expect(response.status).toBe(200);
              expect(body).toContain("Welcome to nginx");
            }).pipe(
              Effect.retry({
                schedule: Schedule.spaced("3 seconds"),
                times: 20,
              }),
              Effect.timeout("90 seconds"),
            );
            yield* waitState(site.appName, output.machineId, "started");
            const started = yield* Clock.currentTimeMillis;
            const idleState = mode === "stop" ? "stopped" : "suspended";
            // Only native GETs follow the last public request; no stop, suspend, or update substitutes.
            const idle = yield* machines
              .getMachine({
                app_name: site.appName,
                machine_id: output.machineId,
              })
              .pipe(
                Effect.tap((machine) =>
                  Effect.logInfo("Automatic Fly idle observation", {
                    mode,
                    state: machine.state,
                    instanceId: machine.instance_id,
                  }),
                ),
                Effect.repeat({
                  schedule: Schedule.spaced("10 seconds"),
                  times: 90,
                  until: (machine) => machine.state === idleState,
                }),
                Effect.timeout("15 minutes"),
              );
            expect(idle.state).toBe(idleState);
            expect(idle.cordoned).toBe(false);
            expect(autostopMode(idle.config?.services?.[0]?.autostop)).toBe(
              mode,
            );
            expect(
              idle.config?.metadata?.["alchemy.idle-policy-restored"],
            ).toBe("true");
            yield* Effect.logInfo("Automatic return to idle observed", {
              mode,
              elapsedMs: (yield* Clock.currentTimeMillis) - started,
            });
            expect(
              (yield* census(site.appName)).map((machine) => machine.id),
            ).toEqual(output.machineIds);
          } finally {
            yield* stack.destroy();
            yield* assertAppGone(site.appName);
          }
        }),
      { timeout: 1_200_000 },
    );
  }
});
