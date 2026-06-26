import * as Docker from "@/Docker";
import * as Provider from "@/Provider";
import { inMemoryState } from "@/State";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { spawnSync } from "node:child_process";
import { describe } from "vitest";

const dockerDaemonOk =
  spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

const { test } = Test.make({
  providers: Docker.providers(),
  state: inMemoryState(),
  adopt: true,
});

test.provider("diff replaces a volume when labels change", () =>
  Effect.gen(function* () {
    const volumeProvider = yield* Provider.findProvider(Docker.Volume);
    const volumeDiff = yield* volumeProvider.diff!({
      id: "data",
      instanceId: "instance",
      olds: { name: "data", labels: { usage: "old" } },
      news: { name: "data", labels: { usage: "new" } },
      oldBindings: [],
      newBindings: [],
      output: {
        id: "data",
        name: "data",
        driver: "local",
        driverOpts: {},
        labels: { usage: "old" },
        mountpoint: undefined,
        createdAt: 0,
      },
    });
    expect(volumeDiff).toEqual({ action: "replace", deleteFirst: true });
  }),
);

describe.sequential("Docker.Volume", () => {
  test.provider.skipIf(!dockerDaemonOk)(
    "creates a volume with labels",
    (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const volumeName = "alchemy-test-volume-create";
        yield* Effect.addFinalizer(() =>
          docker.volume.remove(volumeName).pipe(Effect.ignore),
        );
        const volume = yield* stack.deploy(
          Docker.Volume("created-volume", {
            name: volumeName,
            labels: { "com.alchemy.test": "true" },
          }),
        );
        expect(volume.name).toBe(volumeName);
        expect(volume.id).toBe(volumeName);
        expect(volume.driver).toBe("local");
        expect(volume.labels["com.alchemy.test"]).toBe("true");
        expect(volume.mountpoint?.length).toBeGreaterThan(0);
      }),
    { timeout: 120000 },
  );

  test.provider.skipIf(!dockerDaemonOk)(
    "adopts an existing Docker volume",
    (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const volumeName = "alchemy-test-volume-adopt-existing";
        yield* Effect.addFinalizer(() =>
          docker.volume.remove(volumeName).pipe(Effect.ignore),
        );
        yield* docker.volume
          .remove(volumeName)
          .pipe(
            Effect.catchReason("PlatformError", "NotFound", () => Effect.void),
          );
        yield* docker.volume.create({ name: volumeName });

        const volume = yield* stack.deploy(
          Docker.Volume("existing-volume", { name: volumeName }),
        );
        expect(volume.name).toBe(volumeName);
        expect(volume.id).toBe(volumeName);
        expect(volume.driver).toBe("local");
      }),
    { timeout: 120000 },
  );

  test.provider.skipIf(!dockerDaemonOk)(
    "replaces a volume when its labels change",
    (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const volumeName = "alchemy-test-volume-replace";
        yield* docker.volume
          .remove(volumeName)
          .pipe(
            Effect.catchReason("PlatformError", "NotFound", () => Effect.void),
          );
        const first = yield* stack.deploy(
          Docker.Volume("replaceable-volume", {
            labels: { generation: "1" },
          }),
        );
        const second = yield* stack.deploy(
          Docker.Volume("replaceable-volume", {
            labels: { generation: "2" },
          }),
        );
        expect(second.id).not.toBe(first.id);
        expect(second.labels.generation).toBe("2");
      }),
    { timeout: 120000 },
  );
});
