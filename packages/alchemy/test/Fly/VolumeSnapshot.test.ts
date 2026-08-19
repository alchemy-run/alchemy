import * as Fly from "@/Fly";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { Services } from "@distilled.cloud/fly-io";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Fly.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasFlyCreds = !!process.env.FLY_API_TOKEN;

const waitUntilVolumeGone = (appName: string, volumeId: string) =>
  Services.machines
    .volumesGetById({
      app_name: appName,
      volume_id: volumeId,
    })
    .pipe(
      Effect.map((volume) => {
        const state = volume.state;
        return state === "destroyed" ||
          state === "pending_destroy" ||
          state === "scheduled_for_destruction"
          ? ("gone" as const)
          : ("found" as const);
      }),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

const waitUntilAppGone = (appName: string) =>
  Services.machines.appsShow({ app_name: appName }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const waitMachine = (
  appName: string,
  machineId: string,
  state: "started" | "destroyed",
) => {
  const wait = Services.machines
    .machinesWait({
      app_name: appName,
      machine_id: machineId,
      state,
      timeout: 8,
    })
    .pipe(Effect.asVoid);
  if (state === "destroyed") {
    return wait.pipe(
      Effect.catchTag("NotFound", () => Effect.void),
      Effect.retry({
        times: 6,
        schedule: Schedule.exponential("500 millis"),
        while: (e) => e._tag === "GatewayTimeout",
      }),
    );
  }
  return wait.pipe(
    Effect.retry({
      times: 6,
      schedule: Schedule.exponential("500 millis"),
      while: (e) => e._tag === "NotFound" || e._tag === "GatewayTimeout",
    }),
  );
};

/**
 * Fly refuses snapshots of a never-mounted volume (`BadRequest`:
 * "unable to perform backup against uninitialized volume"). Mount
 * once on a cheapest nginx Machine so the filesystem is formatted,
 * then destroy the Machine so the Volume can be deleted later.
 */
const initializeVolume = (appName: string, volumeId: string) =>
  Effect.gen(function* () {
    const machine = yield* Services.machines.machinesCreate({
      app_name: appName,
      region: "iad",
      config: {
        image: "nginx:alpine",
        guest: { cpu_kind: "shared", cpus: 1, memory_mb: 256 },
        mounts: [{ volume: volumeId, path: "/data" }],
        auto_destroy: true,
      },
    });
    const machineId = machine.id;
    if (machineId === undefined || machineId.length === 0) return;
    yield* waitMachine(appName, machineId, "started");
    yield* Services.machines
      .machinesDelete({
        app_name: appName,
        machine_id: machineId,
        force: true,
      })
      .pipe(Effect.catchTag("NotFound", () => Effect.void));
    yield* waitMachine(appName, machineId, "destroyed");
  });

const listedHas = (appName: string, volumeId: string, snapshotId: string) =>
  Services.machines
    .volumesListSnapshots({
      app_name: appName,
      volume_id: volumeId,
    })
    .pipe(
      Effect.map((snapshots) =>
        snapshots.find((snapshot) => snapshot.id === snapshotId),
      ),
    );

test.provider.skipIf(!hasFlyCreds)(
  "create, update, and destroy a volume snapshot",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const base = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("SnapSite");
          const volume = yield* Fly.Volume("SnapData", {
            app,
            region: "iad",
            sizeGb: 1,
            autoBackupEnabled: false,
          });
          return { app, volume };
        }),
      );

      yield* initializeVolume(base.app.appName, base.volume.volumeId);

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("SnapSite");
          const volume = yield* Fly.Volume("SnapData", {
            app,
            region: "iad",
            sizeGb: 1,
            autoBackupEnabled: false,
          });
          const snapshot = yield* Fly.VolumeSnapshot("Nightly", {
            app,
            volume,
          });
          return { app, volume, snapshot };
        }),
      );

      expect(created.snapshot.snapshotId).toEqual(expect.any(String));
      expect(created.snapshot.snapshotId.length).toBeGreaterThan(0);
      expect(created.snapshot.appName).toEqual(created.app.appName);
      expect(created.snapshot.volumeId).toEqual(created.volume.volumeId);

      const fetched = yield* listedHas(
        created.app.appName,
        created.volume.volumeId,
        created.snapshot.snapshotId,
      );
      expect(fetched).toBeDefined();
      expect(fetched?.id).toEqual(created.snapshot.snapshotId);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("SnapSite");
          const volume = yield* Fly.Volume("SnapData", {
            app,
            region: "iad",
            sizeGb: 1,
            autoBackupEnabled: false,
          });
          const snapshot = yield* Fly.VolumeSnapshot("Nightly", {
            app,
            volume,
          });
          return { app, volume, snapshot };
        }),
      );

      expect(updated.snapshot.snapshotId).toEqual(created.snapshot.snapshotId);
      expect(updated.snapshot.volumeId).toEqual(created.volume.volumeId);
      expect(updated.snapshot.appName).toEqual(created.app.appName);

      const provider = yield* Provider.findProvider(Fly.VolumeSnapshot);
      const all = yield* provider.list();
      const listed = all.find(
        (row) => row.snapshotId === created.snapshot.snapshotId,
      );
      expect(listed).toBeDefined();
      expect(listed?.appName).toEqual(created.app.appName);
      expect(listed?.volumeId).toEqual(created.volume.volumeId);

      yield* stack.destroy();

      const volumeGone = yield* waitUntilVolumeGone(
        created.volume.appName,
        created.volume.volumeId,
      );
      expect(volumeGone).toEqual("gone");
      const appGone = yield* waitUntilAppGone(created.app.appName);
      expect(appGone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!hasFlyCreds)(
  "replace when the volume changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const base = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("SnapReplaceSite");
          const volumeA = yield* Fly.Volume("SnapReplaceA", {
            app,
            region: "iad",
            sizeGb: 1,
            autoBackupEnabled: false,
          });
          const volumeB = yield* Fly.Volume("SnapReplaceB", {
            app,
            region: "iad",
            sizeGb: 1,
            autoBackupEnabled: false,
          });
          return { app, volumeA, volumeB };
        }),
      );

      yield* initializeVolume(base.app.appName, base.volumeA.volumeId);
      yield* initializeVolume(base.app.appName, base.volumeB.volumeId);

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("SnapReplaceSite");
          const volumeA = yield* Fly.Volume("SnapReplaceA", {
            app,
            region: "iad",
            sizeGb: 1,
            autoBackupEnabled: false,
          });
          const volumeB = yield* Fly.Volume("SnapReplaceB", {
            app,
            region: "iad",
            sizeGb: 1,
            autoBackupEnabled: false,
          });
          const snapshot = yield* Fly.VolumeSnapshot("Retarget", {
            app,
            volume: volumeA,
          });
          return { app, volumeA, volumeB, snapshot };
        }),
      );

      expect(created.snapshot.volumeId).toEqual(created.volumeA.volumeId);

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("SnapReplaceSite");
          const volumeA = yield* Fly.Volume("SnapReplaceA", {
            app,
            region: "iad",
            sizeGb: 1,
            autoBackupEnabled: false,
          });
          const volumeB = yield* Fly.Volume("SnapReplaceB", {
            app,
            region: "iad",
            sizeGb: 1,
            autoBackupEnabled: false,
          });
          const snapshot = yield* Fly.VolumeSnapshot("Retarget", {
            app,
            volume: volumeB,
          });
          return { app, volumeA, volumeB, snapshot };
        }),
      );

      expect(replaced.snapshot.snapshotId).not.toEqual(
        created.snapshot.snapshotId,
      );
      expect(replaced.snapshot.volumeId).toEqual(replaced.volumeB.volumeId);
      expect(replaced.snapshot.volumeId).not.toEqual(created.volumeA.volumeId);
      expect(replaced.snapshot.appName).toEqual(created.app.appName);

      const fetched = yield* listedHas(
        replaced.app.appName,
        replaced.volumeB.volumeId,
        replaced.snapshot.snapshotId,
      );
      expect(fetched).toBeDefined();
      expect(fetched?.id).toEqual(replaced.snapshot.snapshotId);

      yield* stack.destroy();

      const oldGone = yield* waitUntilVolumeGone(
        created.volumeA.appName,
        created.volumeA.volumeId,
      );
      expect(oldGone).toEqual("gone");
      const newGone = yield* waitUntilVolumeGone(
        replaced.volumeB.appName,
        replaced.volumeB.volumeId,
      );
      expect(newGone).toEqual("gone");
      const appGone = yield* waitUntilAppGone(created.app.appName);
      expect(appGone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
