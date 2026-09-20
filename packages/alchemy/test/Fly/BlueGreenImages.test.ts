import * as machines from "@distilled.cloud/fly-io/machines";
import * as Fly from "@/Fly";
import * as Docker from "@/Docker";
import { scratchStack } from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";
import { engineActor } from "./fixtures/actors.ts";
import { transportProxy } from "./fixtures/transport.ts";
import {
  assertAppGone,
  assertCommitted,
  deployWorker,
} from "./fixtures/bluegreen.ts";

const { test } = Test.make({ providers: Fly.providers() });

test.provider(
  "S08 mixed real image digests and invalid recovery pin replace the complete generation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const initial = yield* deployWorker(stack, "one", { count: 2 });
      const first = yield* machines.getMachine({
        app_name: initial.appName,
        machine_id: initial.machineIds[0]!,
      });
      const target = {
        app_name: initial.appName,
        machine_id: initial.machineIds[1]!,
      };
      const second = yield* machines.getMachine(target);
      yield* machines.updateMachine({
        ...target,
        config: { ...second.config, image: "nginx:1.26-alpine" },
      });
      const drifted = yield* machines.getMachine(target).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          times: 8,
          until: (machine) =>
            machine.state === "started" &&
            !!machine.image_ref?.digest &&
            machine.image_ref.digest !== first.image_ref?.digest,
        }),
      );
      expect(drifted.state).toBe("started");
      expect(drifted.image_ref?.digest).toBeDefined();
      expect(drifted.image_ref?.digest).not.toBe(first.image_ref?.digest);
      const repaired = yield* deployWorker(stack, "one", {
        count: 2,
        deploy: { strategy: "bluegreen", healthTimeout: "25 seconds" },
      });
      expect(
        repaired.machineIds.every((id) => !initial.machineIds.includes(id)),
      ).toBe(true);
      const live = yield* assertCommitted(initial.appName, repaired.machineIds);
      expect(
        live.every((machine) =>
          machine.config?.metadata?.["alchemy.image"]?.endsWith(
            machine.image_ref!.digest!,
          ),
        ),
      ).toBe(true);
      yield* stack.destroy();
      yield* assertAppGone(initial.appName);
    }),
  { timeout: 300_000 },
);

const mutableTitle =
  "S08 a real Fly registry mutable-tag change after first resolution cannot split the generation";
test.provider(
  mutableTitle,
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const initial = yield* deployWorker(stack, "one");
      const publisher = yield* Effect.sync(() =>
        scratchStack(
          { providers: Docker.providers(), stage: stack.stage },
          `${mutableTitle} publisher`,
          "test/Fly/BlueGreenImages.test.ts",
        ),
      );
      yield* publisher.destroy();
      yield* Effect.gen(function* () {
        const minted = yield* machines.createAppDeployToken({
          app_name: initial.appName,
        });
        expect(minted.token).toBeDefined();
        const publish = (tag: string) =>
          publisher.deploy(
            Docker.RemoteImage("Mutable", {
              name: "nginx",
              tag,
              platform: "linux/amd64",
              targetName: initial.appName,
              targetTag: "acceptance-mutable",
              registry: {
                server: "registry.fly.io",
                username: "x",
                password: Redacted.make(minted.token!),
              },
            }),
          );
        // Upload both layer sets before holding a provider call with its own bounded deadline.
        yield* publish("1.27-alpine");
        const original = yield* publish("1.26-alpine");
        expect(original.imageRef).toBe(
          `registry.fly.io/${initial.appName}:acceptance-mutable`,
        );
        const proxy = yield* transportProxy();
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
            mutableTitle,
            "test/Fly/BlueGreenImages.test.ts",
            proxy.url,
          );
          const rollout = yield* deployWorker(actor, "two", {
            image: original.imageRef,
            count: 3,
          }).pipe(Effect.scoped, Effect.forkScoped);
          const held = yield* proxy.wait(
            (event) => event.stage === "held" && event.status! < 300,
          );
          expect(held.digest).toMatch(/^sha256:/);
          const moved = yield* publish("1.27-alpine");
          expect(moved.imageRef).toBe(original.imageRef);
          expect(moved.repoDigest).toBeDefined();
          expect(moved.repoDigest).not.toBe(original.repoDigest);
          expect(
            proxy.events.filter(
              (event) =>
                event.stage === "request" &&
                event.method === "POST" &&
                event.path.endsWith("/machines"),
            ),
          ).toHaveLength(1);
          const probe = yield* machines.createMachine({
            app_name: initial.appName,
            name: "mutable-tag-probe",
            region: "iad",
            skip_launch: true,
            skip_service_registration: true,
            config: { image: moved.imageRef },
          });
          yield* Effect.gen(function* () {
            expect(probe.image_ref?.digest).toMatch(/^sha256:/);
            expect(probe.image_ref?.digest).not.toBe(held.digest);
            yield* Effect.sync(proxy.release);
            const next = yield* Fiber.join(rollout).pipe(
              Effect.timeout("180 seconds"),
            );
            const creates = proxy.events.filter(
              (event) =>
                event.stage === "completed" &&
                event.method === "POST" &&
                event.path.endsWith("/machines") &&
                event.status! < 300,
            );
            expect(creates).toHaveLength(3);
            expect(creates.every((event) => event.digest === held.digest)).toBe(
              true,
            );
            expect(
              creates
                .slice(1)
                .every((event) => event.image?.endsWith(`@${held.digest}`)),
            ).toBe(true);
            for (const id of next.machineIds) {
              const machine = yield* machines.getMachine({
                app_name: initial.appName,
                machine_id: id,
              });
              expect(machine.image_ref?.digest).toBe(held.digest);
              expect(
                machine.config?.metadata?.["alchemy.image"]?.endsWith(
                  `@${held.digest}`,
                ),
              ).toBe(true);
            }
            expect(next.machineIds).toContain(held.machineId);
            expect(next.machineIds).not.toContain(initial.machineId);
          }).pipe(
            Effect.ensuring(
              machines
                .deleteMachine({
                  app_name: initial.appName,
                  machine_id: probe.id!,
                  force: true,
                })
                .pipe(
                  Effect.catchTag("NotFound", () => Effect.void),
                  Effect.orDie,
                ),
            ),
          );
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              proxy.clear();
              proxy.release();
            }),
          ),
          Effect.scoped,
        );
        const live = yield* machines.listMachines({
          app_name: initial.appName,
        });
        const active = live.filter((machine) => machine.state !== "destroyed");
        expect(active).toHaveLength(3);
        yield* assertCommitted(
          initial.appName,
          active.map((machine) => machine.id!),
        );
      }).pipe(Effect.ensuring(publisher.destroy().pipe(Effect.orDie)));
      yield* stack.destroy();
      yield* assertAppGone(initial.appName);
    }).pipe(Effect.scoped),
  { timeout: 600_000 },
);
