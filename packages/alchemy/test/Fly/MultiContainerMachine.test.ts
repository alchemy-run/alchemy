import * as machines from "@distilled.cloud/fly-io/machines";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

import * as Fly from "@/Fly";
import type { MachineContainer } from "@/Fly/Machine";
import * as Test from "@/Test/Alchemy";

const { test } = Test.make({ providers: Fly.providers() });
const image =
  "docker-hub-mirror.fly.io/library/nginx@sha256:7396be67b6f53012a5cf955fa9040619294c25ccacf11e22af5de1b572fc756e";
const orgSlug = process.env.FLY_ORG;

const workload = (sidecarVersion: string): MachineContainer[] => [
  {
    name: "web",
    image,
    env: { ROLE: "web" },
    healthChecks: [
      {
        name: "web-tcp",
        kind: "readiness" as const,
        tcp: { port: 80 },
        interval: 5,
        timeout: 2,
      },
    ],
  },
  {
    name: "sidecar",
    image,
    cmd: ["sh", "-c", "sleep 300"],
    env: { ROLE: "sidecar", VERSION: sidecarVersion },
    dependsOn: [{ name: "web", condition: "healthy" as const }],
  },
];

test.provider.skipIf(orgSlug === undefined)(
  "rolling named containers preserve group, digest pins, and mounted data",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (version: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const app = yield* Fly.App("MultiContainerSite", { orgSlug });
            return yield* Fly.Machine("Group", {
              app,
              region: "fra",
              guest: { cpus: 1, memoryMb: 256 },
              env: { COMMON: "machine", ROLE: "machine" },
              containers: workload(version),
              mounts: [{ path: "/data", sizeGb: 1, encrypted: true }],
            });
          }),
        );
      const first = yield* deploy("one");
      expect(first.state).toEqual("started");
      const target = { app_name: first.appName, machine_id: first.machineId };
      const observed = yield* machines.getMachine(target);
      expect(
        observed.config?.containers?.map((container) => container.name),
      ).toEqual(["web", "sidecar"]);
      expect(
        observed.config?.containers?.map((container) => container.image),
      ).toEqual([image, image]);
      expect(observed.config?.env?.COMMON).toEqual("machine");
      expect(observed.config?.containers?.[0]?.env?.ROLE).toEqual("web");
      expect(observed.config?.containers?.[1]?.env?.ROLE).toEqual("sidecar");
      expect(observed.config?.containers?.[1]?.depends_on).toEqual([
        { name: "web", condition: "healthy" },
      ]);

      const connected = yield* machines
        .execMachine({
          ...target,
          container: "sidecar",
          command: [
            "sh",
            "-c",
            "wget -qO- http://127.0.0.1:80/ | grep -q 'Welcome to nginx' && printf connected",
          ],
          timeout: 10,
        })
        .pipe(
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            times: 8,
            until: (result) => result.stdout?.includes("connected") === true,
          }),
        );
      expect(connected.stdout).toContain("connected");
      expect(connected.exit_code).toBe(0);
      const environment = yield* machines.execMachine({
        ...target,
        container: "sidecar",
        command: ["sh", "-c", 'printf "%s|%s" "$COMMON" "$ROLE"'],
        timeout: 10,
      });
      expect(environment.stdout).toContain("machine|sidecar");
      expect(environment.exit_code).toBe(0);
      const written = yield* machines.execMachine({
        ...target,
        container: "web",
        command: [
          "sh",
          "-c",
          "printf persistent > /data/ogm-1764-marker && cat /data/ogm-1764-marker",
        ],
        timeout: 10,
      });
      expect(written.stdout).toContain("persistent");

      const unchanged = yield* deploy("one");
      expect(unchanged.machineId).toEqual(first.machineId);
      const same = yield* machines.getMachine(target);
      expect(same.instance_id).toEqual(observed.instance_id);

      const updated = yield* deploy("two");
      expect(updated.machineId).toEqual(first.machineId);
      expect(updated.mounts[0]?.volumeId).toEqual(first.mounts[0]?.volumeId);
      const after = yield* machines.getMachine(target);
      expect(
        after.config?.containers?.map((container) => container.image),
      ).toEqual([image, image]);
      expect(after.config?.containers?.[1]?.env?.VERSION).toEqual("two");
      const persisted = yield* machines.execMachine({
        ...target,
        container: "web",
        command: ["cat", "/data/ogm-1764-marker"],
        timeout: 10,
      });
      expect(persisted.stdout).toContain("persistent");
      yield* stack.destroy();
      const gone = yield* machines.getApp({ app_name: first.appName }).pipe(
        Effect.as(false),
        Effect.catchTag("NotFound", () => Effect.succeed(true)),
      );
      expect(gone).toBe(true);
    }).pipe(
      Effect.provideService(
        MinimumLogLevel,
        process.env.DEBUG ? "Debug" : "Info",
      ),
    ),
  { timeout: 120_000 },
);
