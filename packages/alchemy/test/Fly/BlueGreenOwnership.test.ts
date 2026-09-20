import * as machines from "@distilled.cloud/fly-io/machines";
import * as Fly from "@/Fly";
import { deleteReplicaSet, observeReplicaSet } from "@/Fly/replicas";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { assertAppGone, census, checks } from "./fixtures/bluegreen.ts";

const { test } = Test.make({ providers: Fly.providers() });

test.provider(
  "S09 foreign routed Machine and sibling survive rollout and stale-instance deletion",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (version: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const app = yield* Fly.App("Site");
            const sibling = yield* Fly.Machine("Sibling", {
              app,
              image: "nginx:alpine",
              env: { VERSION: "sibling" },
            });
            const worker = yield* Fly.Machine("Worker", {
              app,
              image: "nginx:alpine",
              env: { VERSION: version },
              checks,
              deploy: { strategy: "bluegreen", healthTimeout: "20 seconds" },
              shutdown: { signal: "SIGQUIT", timeout: "5 seconds" },
            });
            return { sibling, worker };
          }),
        );
      const initial = yield* deploy("one");
      const foreign = yield* machines.createMachine({
        app_name: initial.worker.appName,
        name: "foreign-routed",
        region: "iad",
        config: {
          image: "nginx:alpine",
          env: { VERSION: "foreign" },
          services: [
            {
              protocol: "tcp",
              internal_port: 80,
              ports: [{ port: 80, handlers: ["http"] }],
            },
          ],
        },
      });
      const removeForeign = machines
        .deleteMachine({
          app_name: initial.worker.appName,
          machine_id: foreign.id!,
          force: true,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* Effect.gen(function* () {
        const next = yield* deploy("two");
        expect(next.worker.machineId).not.toBe(initial.worker.machineId);
        expect(next.sibling.machineId).toBe(initial.sibling.machineId);
        const before = yield* census(initial.worker.appName);
        expect(before.map((machine) => machine.id).sort()).toEqual(
          [next.worker.machineId, next.sibling.machineId, foreign.id!].sort(),
        );
        expect(
          before.find((machine) => machine.id === foreign.id)?.cordoned,
        ).toBe(false);
        const owned = before.find(
          (machine) => machine.id === next.worker.machineId,
        )!;
        yield* deleteReplicaSet({
          appName: next.worker.appName,
          id: "Worker",
          type: "Fly.Machine",
          fqn: owned.config!.metadata!["alchemy.fqn"]!,
          resourceInstanceId: "stale-instance-must-not-delete-successor",
          machineIds: next.worker.machineIds,
          volumeIds: [],
        });
        expect(
          (yield* census(initial.worker.appName))
            .map((machine) => machine.id)
            .sort(),
        ).toEqual(before.map((machine) => machine.id).sort());
      }).pipe(Effect.ensuring(removeForeign.pipe(Effect.orDie)));
      yield* stack.destroy();
      yield* assertAppGone(initial.worker.appName);
    }),
  { timeout: 300_000 },
);

test.provider(
  "S09 F11 stale output and a same-logical-ID foreign FQN cannot authorize successor deletion",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (name: string, version: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const app = yield* Fly.App("Site");
            return yield* Fly.Machine("Worker", {
              app,
              name,
              image: "nginx:alpine",
              checks,
              env: { VERSION: version },
              deploy: { strategy: "bluegreen", healthTimeout: "30 seconds" },
              shutdown: { signal: "SIGQUIT", timeout: "5 seconds" },
            });
          }),
        );
      const initial = yield* deploy("stale-original", "one");
      const old = yield* machines.getMachine({
        app_name: initial.appName,
        machine_id: initial.machineId,
      });
      const oldMetadata = old.config!.metadata!;
      const collision = yield* machines.createMachine({
        app_name: initial.appName,
        name: "fqn-collision",
        region: "iad",
        config: {
          ...old.config,
          metadata: {
            ...oldMetadata,
            "alchemy.fqn": `${oldMetadata["alchemy.fqn"]}/OtherScope`,
          },
        },
      });
      yield* Effect.gen(function* () {
        const next = yield* deploy("stale-original", "two");
        const refreshed = yield* observeReplicaSet({
          appName: initial.appName,
          id: "Worker",
          type: "Fly.Machine",
          fqn: oldMetadata["alchemy.fqn"]!,
          resourceInstanceId: oldMetadata["alchemy.instance"]!,
          baseName: initial.baseName,
          machineIds: [...initial.machineIds, collision.id!],
        });
        expect(refreshed?.machineIds).toEqual(next.machineIds);
        expect(refreshed?.rolloutPending).toBe(false);
        const successor = yield* deploy("stale-successor", "three");
        const current = yield* machines.getMachine({
          app_name: initial.appName,
          machine_id: successor.machineId,
        });
        expect(current.config?.metadata?.["alchemy.instance"]).not.toBe(
          oldMetadata["alchemy.instance"],
        );
        // Even an ID cache containing the new Machine grants no old-lineage authority.
        yield* deleteReplicaSet({
          appName: initial.appName,
          id: "Worker",
          type: "Fly.Machine",
          fqn: oldMetadata["alchemy.fqn"]!,
          resourceInstanceId: oldMetadata["alchemy.instance"]!,
          machineIds: [
            ...initial.machineIds,
            ...next.machineIds,
            ...successor.machineIds,
            collision.id!,
          ],
          volumeIds: [],
        });
        const live = yield* census(initial.appName);
        expect(live.map((machine) => machine.id).sort()).toEqual(
          [successor.machineId, collision.id!].sort(),
        );
        const foreign = live.find((machine) => machine.id === collision.id)!;
        expect(foreign.config?.metadata?.["alchemy.fqn"]).toBe(
          `${oldMetadata["alchemy.fqn"]}/OtherScope`,
        );
        expect(foreign.cordoned).toBe(false);
      }).pipe(
        Effect.ensuring(
          machines
            .deleteMachine({
              app_name: initial.appName,
              machine_id: collision.id!,
              force: true,
            })
            .pipe(
              Effect.catchTag("NotFound", () => Effect.void),
              Effect.orDie,
            ),
        ),
      );
      yield* stack.destroy();
      yield* assertAppGone(initial.appName);
    }),
  { timeout: 600_000 },
);
