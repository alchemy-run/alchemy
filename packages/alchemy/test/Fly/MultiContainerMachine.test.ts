import * as machines from "@distilled.cloud/fly-io/machines";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";

import * as Fly from "@/Fly";
import type { MachineContainer } from "@/Fly/Machine";
import * as Test from "@/Test/Alchemy";

import { throughProxy, transportProxy } from "./fixtures/transport.ts";

const { test } = Test.make({ providers: Fly.providers() });
let endpoint: string | undefined;
const { test: faultTest } = Test.make({
  providers: throughProxy(() => endpoint),
});
const image =
  "docker-hub-mirror.fly.io/library/nginx@sha256:7396be67b6f53012a5cf955fa9040619294c25ccacf11e22af5de1b572fc756e";
const nextImage =
  "docker-hub-mirror.fly.io/library/nginx@sha256:ef8676b33d681f272ba429b27658bdd7e640963279714c96bddf1dc76307f7b6";
const orgSlug = process.env.FLY_ORG;

const workload = (
  sidecarVersion: string,
  includeObsolete = true,
): MachineContainer[] => [
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
    image: sidecarVersion === "two" ? nextImage : image,
    cmd: ["sh", "-c", "sleep 300"],
    env: { ROLE: "sidecar", VERSION: sidecarVersion },
    dependsOn: [{ name: "web", condition: "healthy" as const }],
  },
  ...(includeObsolete
    ? [{ name: "obsolete", image, cmd: ["sh", "-c", "sleep 300"] }]
    : []),
];

test.provider.skipIf(orgSlug === undefined)(
  "rolling named containers preserve group, digest pins, and mounted data",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (version: string, includeObsolete = true) =>
        stack.deploy(
          Effect.gen(function* () {
            const app = yield* Fly.App("MultiContainerSite", { orgSlug });
            return yield* Fly.Machine("Group", {
              app,
              region: "fra",
              guest: { cpus: 1, memoryMb: 256 },
              env: { COMMON: "machine", ROLE: "machine" },
              containers: workload(version, includeObsolete),
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
      ).toEqual(["web", "sidecar", "obsolete"]);
      expect(
        observed.config?.containers?.map((container) => container.image),
      ).toEqual([image, image, image]);
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

      const updated = yield* deploy("two", false);
      expect(updated.machineId).toEqual(first.machineId);
      expect(updated.mounts[0]?.volumeId).toEqual(first.mounts[0]?.volumeId);
      const after = yield* machines.getMachine(target);
      expect(
        after.config?.containers?.map((container) => container.name),
      ).toEqual(["web", "sidecar"]);
      expect(
        after.config?.containers?.map((container) => container.image),
      ).toEqual([image, nextImage]);
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

faultTest.provider.skipIf(orgSlug === undefined)(
  "lost rolling update response converges the owned named group on rerun",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (sidecarImage: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const app = yield* Fly.App("InterruptedMultiContainerSite", {
              orgSlug,
            });
            return yield* Fly.Machine("Group", {
              app,
              region: "fra",
              guest: { cpus: 1, memoryMb: 256 },
              mounts: [{ path: "/data", sizeGb: 1, encrypted: true }],
              containers: [
                { name: "web", image },
                {
                  name: "sidecar",
                  image: sidecarImage,
                  cmd: ["sh", "-c", "sleep 300"],
                },
              ],
            });
          }),
        );
      const first = yield* deploy(image);
      const interrupted = yield* Effect.scoped(
        Effect.gen(function* () {
          const proxy = yield* transportProxy();
          endpoint = proxy.url;
          proxy.arm({
            match: (event) =>
              event.method === "POST" &&
              event.path.endsWith(`/machines/${first.machineId}`),
            action: "drop-response",
            remaining: 1,
          });
          const result = yield* deploy(nextImage).pipe(Effect.result);
          const dropped = proxy.events.filter(
            (event) => event.stage === "dropped",
          );
          expect(dropped).toHaveLength(1);
          expect(dropped[0]?.status).toBe(200);
          return { result, acceptedInstanceId: dropped[0]?.instanceId };
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              endpoint = undefined;
            }),
          ),
        ),
      );
      expect(Result.isFailure(interrupted.result)).toBe(true);
      if (interrupted.acceptedInstanceId === undefined)
        return yield* Effect.fail(
          new Error("Accepted update did not report an instance ID"),
        );
      yield* machines.waitMachine({
        app_name: first.appName,
        machine_id: first.machineId,
        state: "started",
        instance_id: interrupted.acceptedInstanceId,
        timeout: 30,
      });
      const settled = yield* machines.getMachine({
        app_name: first.appName,
        machine_id: first.machineId,
      });
      expect(settled.instance_id).toBe(interrupted.acceptedInstanceId);
      expect(settled.config?.containers?.[1]?.image).toBe(nextImage);
      const converged = yield* deploy(nextImage);
      expect(converged.machineId).toBe(first.machineId);
      expect(converged.mounts[0]?.volumeId).toBe(first.mounts[0]?.volumeId);
      const observed = yield* machines.getMachine({
        app_name: first.appName,
        machine_id: first.machineId,
      });
      expect(
        observed.config?.containers?.map(({ name, image }) => ({
          name,
          image,
        })),
      ).toEqual([
        { name: "web", image },
        { name: "sidecar", image: nextImage },
      ]);
      const inventory = (yield* machines.listMachines({
        app_name: first.appName,
      })).filter((machine) => machine.state !== "destroyed");
      expect(inventory.map(({ id }) => id)).toEqual([first.machineId]);
      const volumes = yield* machines.listVolumes({ app_name: first.appName });
      expect(volumes.map(({ id }) => id)).toEqual([first.mounts[0]?.volumeId]);
      yield* stack.destroy();
      const gone = yield* machines.getApp({ app_name: first.appName }).pipe(
        Effect.as(false),
        Effect.catchTag("NotFound", () => Effect.succeed(true)),
      );
      expect(gone).toBe(true);
    }),
  { timeout: 120_000 },
);
