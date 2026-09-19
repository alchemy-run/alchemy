import * as machines from "@distilled.cloud/fly-io/machines";
import * as Fly from "@/Fly";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Fly.providers() });

for (const [before, after] of [
  [1, 2],
  [2, 1],
] as const) {
  test.provider(
    `replaces the complete replica set when scaling from ${before} to ${after}`,
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const deploy = (count: number, strategy: "rolling" | "bluegreen") =>
          stack.deploy(
            Effect.gen(function* () {
              const app = yield* Fly.App("Site");
              return yield* Fly.Machine("Worker", {
                app,
                name: "scaling-worker",
                image: "nginx:alpine",
                count,
                deploy: { strategy, healthTimeout: "30 seconds" },
                shutdown: { signal: "SIGQUIT", timeout: "10 seconds" },
                checks: {
                  ready: {
                    type: "http",
                    port: 80,
                    path: "/",
                    interval: "2s",
                    timeout: "1s",
                  },
                },
              });
            }),
          );
        const initial = yield* deploy(
          before,
          before === 2 ? "rolling" : "bluegreen",
        );
        if (before === 2) {
          // Reproduce the ownership metadata written before generation support.
          for (const machineId of initial.machineIds) {
            for (const key of [
              "alchemy.instance",
              "alchemy.fqn",
              "alchemy.baseName",
            ]) {
              yield* machines.deleteMachineMetadata({
                app_name: initial.appName,
                machine_id: machineId,
                key,
              });
            }
          }
          const legacy = yield* machines
            .listMachines({ app_name: initial.appName })
            .pipe(
              Effect.repeat({
                schedule: Schedule.spaced("1 second"),
                until: (listed) =>
                  listed.every(
                    (machine) =>
                      machine.config?.metadata?.["alchemy.instance"] ===
                      undefined,
                  ),
                times: 8,
              }),
            );
          expect(
            legacy.every(
              (machine) =>
                machine.config?.metadata?.["alchemy.instance"] === undefined,
            ),
          ).toBe(true);
        }
        const scaled = yield* deploy(after, "bluegreen");
        expect(scaled.count).toBe(after);
        expect(scaled.machineIds).toHaveLength(after);
        expect(
          scaled.machineIds.every((id) => !initial.machineIds.includes(id)),
        ).toBe(true);
        const live = (yield* machines.listMachines({
          app_name: initial.appName,
        })).filter((machine) => machine.state !== "destroyed");
        expect(live).toHaveLength(after);
        expect(
          live.every(
            (machine) =>
              machine.cordoned === false &&
              machine.config?.metadata?.["alchemy.phase"] === "active",
          ),
        ).toBe(true);
        expect(
          new Set(live.map((machine) => machine.image_ref?.digest)).size,
        ).toBe(1);
        yield* stack.destroy();
      }),
    { timeout: 120_000 },
  );
}
