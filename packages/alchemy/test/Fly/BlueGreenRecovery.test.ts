import * as machines from "@distilled.cloud/fly-io/machines";
import * as Fly from "@/Fly";
import { deleteReplicaSet, observeReplicaSet } from "@/Fly/replicas";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Fly.providers() });
const checks = {
  ready: {
    type: "http" as const,
    port: 80,
    path: "/",
    interval: "2s",
    timeout: "1s",
  },
};

test.provider(
  "recovers partial promotion as one generation and preserves policy-only identity",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (healthTimeout: number) =>
        stack.deploy(
          Effect.gen(function* () {
            const app = yield* Fly.App("Site");
            return yield* Fly.Machine("Worker", {
              app,
              count: 2,
              image: "nginx:alpine",
              checks,
              deploy: { strategy: "bluegreen", healthTimeout },
              shutdown: { signal: "SIGQUIT", timeout: "10 seconds" },
            });
          }),
        );
      const initial = yield* deploy(30_000);
      const source = yield* machines.getMachine({
        app_name: initial.appName,
        machine_id: initial.machineId,
      });
      const metadata = source.config!.metadata!;
      const candidates = [];
      for (let index = 0; index < 2; index++) {
        candidates.push(
          yield* machines.createMachine({
            app_name: initial.appName,
            name: `interrupted-promotion-${index}`,
            region: "iad",
            skip_service_registration: index !== 0,
            config: {
              ...source.config,
              image: metadata["alchemy.image"],
              metadata: {
                ...metadata,
                "alchemy.generation": "interrupted",
                "alchemy.sequence": "2",
                "alchemy.replica": String(index),
                "alchemy.phase": index === 0 ? "active" : "promoting",
              },
            },
          }),
        );
      }
      const read = yield* observeReplicaSet({
        appName: initial.appName,
        id: "Worker",
        type: "Fly.Machine",
        fqn: metadata["alchemy.fqn"]!,
        resourceInstanceId: metadata["alchemy.instance"]!,
        baseName: initial.baseName,
        machineIds: initial.machineIds,
      });
      expect(read?.machineIds).toEqual(initial.machineIds);
      expect(read?.count).toBe(2);
      expect(read?.rolloutPending).toBe(true);
      const recovered = yield* deploy(40_000);
      expect(recovered.machineIds).toEqual(
        candidates.map((machine) => machine.id),
      );
      expect(
        (yield* machines.listMachines({ app_name: initial.appName })).filter(
          (machine) => machine.state !== "destroyed",
        ),
      ).toHaveLength(2);
      const unchanged = yield* deploy(45_000);
      expect(unchanged.machineIds).toEqual(recovered.machineIds);
      yield* stack.destroy();
    }),
  { timeout: 300_000 },
);

test.provider(
  "rolling opt-out retires unfinished candidates without changing the surviving ID",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (strategy: "rolling" | "bluegreen") =>
        stack.deploy(
          Effect.gen(function* () {
            const app = yield* Fly.App("Site");
            const other = yield* Fly.Machine("Other", {
              app,
              image: "nginx:alpine",
            });
            const worker = yield* Fly.Machine("Worker", {
              app,
              image: "nginx:alpine",
              checks,
              deploy: { strategy },
              shutdown: { signal: "SIGQUIT", timeout: "10 seconds" },
            });
            return { other, worker };
          }),
        );
      const initial = yield* deploy("bluegreen");
      const source = yield* machines.getMachine({
        app_name: initial.worker.appName,
        machine_id: initial.worker.machineId,
      });
      const candidate = yield* machines.createMachine({
        app_name: initial.worker.appName,
        name: "interrupted-candidate",
        region: "iad",
        config: {
          ...source.config,
          metadata: {
            ...source.config?.metadata,
            "alchemy.generation": "unfinished",
            "alchemy.sequence": "2",
            "alchemy.phase": "promoting",
          },
        },
      });
      const recovered = yield* deploy("rolling");
      expect(recovered.worker.machineId).toBe(initial.worker.machineId);
      expect(recovered.other.machineId).toBe(initial.other.machineId);
      const live = (yield* machines.listMachines({
        app_name: initial.worker.appName,
      })).filter((machine) => machine.state !== "destroyed");
      expect(live.map((machine) => machine.id).sort()).toEqual(
        [initial.worker.machineId, initial.other.machineId].sort(),
      );
      expect(live.some((machine) => machine.id === candidate.id)).toBe(false);
      yield* stack.destroy();
    }),
  { timeout: 300_000 },
);

test.provider(
  "recovers partial preparation and isolates old engine-instance cleanup",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (healthTimeout: number) =>
        stack.deploy(
          Effect.gen(function* () {
            const app = yield* Fly.App("Site");
            return yield* Fly.Machine("Worker", {
              app,
              count: 2,
              image: "nginx:alpine",
              checks,
              deploy: { strategy: "bluegreen", healthTimeout },
              shutdown: { signal: "SIGQUIT", timeout: "10 seconds" },
            });
          }),
        );
      const initial = yield* deploy(30_000);
      const source = yield* machines.getMachine({
        app_name: initial.appName,
        machine_id: initial.machineId,
      });
      const metadata = source.config!.metadata!;
      const candidate = yield* machines.createMachine({
        app_name: initial.appName,
        name: "interrupted-preparation",
        region: "iad",
        skip_service_registration: true,
        config: {
          ...source.config,
          image: metadata["alchemy.image"],
          metadata: {
            ...metadata,
            "alchemy.generation": "interrupted",
            "alchemy.sequence": "2",
            "alchemy.replica": "0",
            "alchemy.phase": "candidate",
          },
        },
      });
      const read = yield* observeReplicaSet({
        appName: initial.appName,
        id: "Worker",
        type: "Fly.Machine",
        fqn: metadata["alchemy.fqn"]!,
        resourceInstanceId: metadata["alchemy.instance"]!,
        baseName: initial.baseName,
        machineIds: initial.machineIds,
      });
      expect(read?.machineIds).toEqual(initial.machineIds);
      expect(read?.rolloutPending).toBe(true);
      const recovered = yield* deploy(40_000);
      expect(recovered.machineIds[0]).toBe(candidate.id);
      expect(recovered.machineIds).toHaveLength(2);
      yield* deleteReplicaSet({
        appName: initial.appName,
        id: "Worker",
        type: "Fly.Machine",
        fqn: metadata["alchemy.fqn"]!,
        resourceInstanceId: "previous-engine-instance",
        machineIds: recovered.machineIds,
        volumeIds: [],
      });
      const live = (yield* machines.listMachines({
        app_name: initial.appName,
      })).filter((machine) => machine.state !== "destroyed");
      expect(live.map((machine) => machine.id).sort()).toEqual(
        [...recovered.machineIds].sort(),
      );
      yield* stack.destroy();
    }),
  { timeout: 300_000 },
);

test.provider(
  "replaces the entire generation when one replica drifts",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (healthTimeout: number, count = 2) =>
        stack.deploy(
          Effect.gen(function* () {
            const app = yield* Fly.App("Site");
            return yield* Fly.Machine("Worker", {
              app,
              count,
              image: "nginx:alpine",
              checks,
              deploy: { strategy: "bluegreen", healthTimeout },
              shutdown: { signal: "SIGQUIT", timeout: "10 seconds" },
            });
          }),
        );
      const initial = yield* deploy(30_000);
      const target = {
        app_name: initial.appName,
        machine_id: initial.machineIds[1]!,
      };
      const source = yield* machines.getMachine(target);
      const drifted = yield* machines.updateMachine({
        ...target,
        config: { ...source.config, env: { DRIFT: "true" } },
      });
      expect(drifted.config?.env?.DRIFT).toBe("true");
      const observed = yield* machines
        .listMachines({ app_name: initial.appName })
        .pipe(
          Effect.map((listed) =>
            listed.find((machine) => machine.id === target.machine_id),
          ),
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (machine) =>
              machine?.state === "started" &&
              machine.config?.env?.DRIFT === "true",
            times: 10,
          }),
        );
      expect(observed?.config?.env?.DRIFT).toBe("true");
      expect(observed?.state).toBe("started");
      const recovered = yield* deploy(40_000);
      expect(
        recovered.machineIds.every((id) => !initial.machineIds.includes(id)),
      ).toBe(true);
      const live = (yield* machines.listMachines({
        app_name: initial.appName,
      })).filter((machine) => machine.state !== "destroyed");
      expect(live).toHaveLength(2);
      expect(
        live.every((machine) => machine.config?.env?.DRIFT === undefined),
      ).toBe(true);
      expect(
        new Set(live.map((machine) => machine.image_ref?.digest)).size,
      ).toBe(1);
      yield* stack.destroy();
    }),
  { timeout: 300_000 },
);
