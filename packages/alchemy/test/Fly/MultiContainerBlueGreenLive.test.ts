import * as machines from "@distilled.cloud/fly-io/machines";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";

import * as Fly from "@/Fly";
import type { MachineContainer } from "@/Fly/Machine";
import { waitHealthy } from "@/Fly/replicas";
import * as Test from "@/Test/Alchemy";
import type { ScratchStack } from "@/Test/Alchemy";

const { test } = Test.make({ providers: Fly.providers() });
const orgSlug = process.env.FLY_ORG;
const firstImage =
  "docker-hub-mirror.fly.io/library/nginx@sha256:7396be67b6f53012a5cf955fa9040619294c25ccacf11e22af5de1b572fc756e";
const nextImage =
  "docker-hub-mirror.fly.io/library/nginx@sha256:ef8676b33d681f272ba429b27658bdd7e640963279714c96bddf1dc76307f7b6";

const containers = (
  sidecarImage: string,
  reversed = false,
): MachineContainer[] => {
  const group: MachineContainer[] = [
    {
      name: "web",
      image: firstImage,
      healthChecks: [
        {
          name: "web-tcp",
          kind: "readiness",
          tcp: { port: 80 },
          interval: 5,
          timeout: 2,
        },
      ],
    },
    {
      name: "sidecar",
      image: sidecarImage,
      cmd: [
        "sh",
        "-c",
        "sed -i 's/80/8080/g' /etc/nginx/conf.d/default.conf; exec nginx -g 'daemon off;'",
      ],
      dependsOn: [{ name: "web", condition: "healthy" }],
      healthChecks: [
        {
          name: "sidecar-tcp",
          kind: "readiness",
          tcp: { port: 8080 },
          interval: 5,
          timeout: 2,
        },
      ],
    },
  ];
  return reversed ? group.reverse() : group;
};

const deploy = (
  stack: ScratchStack,
  sidecarImage: string,
  count: number,
  reversed = false,
  badHealth = false,
) =>
  stack.deploy(
    Effect.gen(function* () {
      const app = yield* Fly.App("MultiContainerBlueGreenSite", { orgSlug });
      return yield* Fly.Machine("Group", {
        app,
        region: "fra",
        count,
        guest: { cpus: 1, memoryMb: 256 },
        containers: containers(sidecarImage, reversed),
        checks: {
          web: { type: "tcp", port: 80, interval: "2s", timeout: "1s" },
          sidecar: {
            type: "tcp",
            port: badHealth ? 9999 : 8080,
            interval: "2s",
            timeout: "1s",
          },
        },
        deploy: {
          strategy: "bluegreen",
          healthTimeout: badHealth ? "15 seconds" : "60 seconds",
        },
        shutdown: { signal: "SIGTERM", timeout: "1 second" },
      });
    }),
  );

const appGone = (appName: string) =>
  machines.getApp({ app_name: appName }).pipe(
    Effect.as(false),
    Effect.catchTag("NotFound", () => Effect.succeed(true)),
  );

test.provider.skipIf(orgSlug === undefined)(
  "blue/green checks two named-container replicas and ignores declaration order",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const first = yield* deploy(stack, firstImage, 2);
      expect(first.machineIds).toHaveLength(2);
      const observed = yield* Effect.forEach(first.machineIds, (machineId) =>
        machines.getMachine({ app_name: first.appName, machine_id: machineId }),
      );
      for (const machine of observed) {
        expect(
          machine.config?.containers?.map(({ name, image }) => ({
            name,
            image,
          })),
        ).toEqual([
          { name: "web", image: firstImage },
          { name: "sidecar", image: firstImage },
        ]);
        expect(machine.cordoned).toBe(false);
        expect(machine.config?.metadata?.["alchemy.phase"]).toBe("active");
        const ready = yield* waitHealthy(first.appName, machine, 30_000);
        expect(
          ready.checks?.some(
            ({ name, status }) => name === "web" && status === "passing",
          ),
        ).toBe(true);
        expect(
          ready.checks?.some(
            ({ name, status }) => name === "sidecar" && status === "passing",
          ),
        ).toBe(true);
      }
      const reordered = yield* deploy(stack, firstImage, 2, true);
      expect([...reordered.machineIds].sort()).toEqual(
        [...first.machineIds].sort(),
      );
      yield* stack.destroy();
      expect(yield* appGone(first.appName)).toBe(true);
    }),
  { timeout: 120_000 },
);

test.provider.skipIf(orgSlug === undefined)(
  "blue/green replaces a named group when only its sidecar image changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const first = yield* deploy(stack, firstImage, 1);
      const updated = yield* deploy(stack, nextImage, 1, true);
      expect(updated.machineId).not.toBe(first.machineId);
      const replacement = yield* machines.getMachine({
        app_name: updated.appName,
        machine_id: updated.machineId,
      });
      expect(
        replacement.config?.containers
          ?.map(({ name, image }) => ({ name, image }))
          .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")),
      ).toEqual([
        { name: "sidecar", image: nextImage },
        { name: "web", image: firstImage },
      ]);
      expect(replacement.cordoned).toBe(false);
      expect(replacement.config?.metadata?.["alchemy.phase"]).toBe("active");
      const retired = yield* machines
        .getMachine({ app_name: first.appName, machine_id: first.machineId })
        .pipe(
          Effect.map((machine) => machine.state === "destroyed"),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            times: 10,
            until: (gone) => gone,
          }),
        );
      expect(retired).toBe(true);
      yield* stack.destroy();
      expect(yield* appGone(first.appName)).toBe(true);
    }),
  { timeout: 120_000 },
);

test.provider.skipIf(orgSlug === undefined)(
  "bad secondary readiness preserves the serving predecessor",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const first = yield* deploy(stack, firstImage, 1);
      const failed = yield* deploy(stack, nextImage, 1, false, true).pipe(
        Effect.result,
      );
      expect(Result.isFailure(failed)).toBe(true);
      const predecessor = yield* machines.getMachine({
        app_name: first.appName,
        machine_id: first.machineId,
      });
      expect(predecessor.state).toBe("started");
      expect(predecessor.cordoned).toBe(false);
      expect(predecessor.config?.metadata?.["alchemy.phase"]).toBe("active");
      expect(
        predecessor.config?.containers?.find(({ name }) => name === "sidecar")
          ?.image,
      ).toBe(firstImage);
      yield* stack.destroy();
      expect(yield* appGone(first.appName)).toBe(true);
    }),
  { timeout: 120_000 },
);
