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

const waitUntilGone = (appName: string, volumeId: string) =>
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

test.provider.skipIf(!hasFlyCreds)(
  "create, update, and delete an unattached volume",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("Site");
          return yield* Fly.Volume("Data", {
            app,
            region: "iad",
            sizeGb: 1,
            encrypted: true,
          });
        }),
      );

      expect(created.volumeId).toEqual(expect.any(String));
      expect(created.volumeId.length).toBeGreaterThan(0);
      expect(created.appName).toEqual(expect.any(String));
      expect(created.name).toEqual(expect.any(String));
      expect(created.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(created.region).toEqual("iad");
      expect(created.sizeGb).toEqual(1);
      expect(created.encrypted).toEqual(true);
      expect(created.attachedMachineId).toBeUndefined();

      const fetched = yield* Services.machines.volumesGetById({
        app_name: created.appName,
        volume_id: created.volumeId,
      });
      expect(fetched.id).toEqual(created.volumeId);
      expect(fetched.name).toEqual(created.name);
      expect(fetched.region).toEqual("iad");
      expect(fetched.size_gb).toEqual(1);
      expect(fetched.encrypted).toEqual(true);
      expect(fetched.attached_machine_id ?? undefined).toBeUndefined();

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("Site");
          return yield* Fly.Volume("Data", {
            app,
            region: "iad",
            sizeGb: 2,
            encrypted: true,
            autoBackupEnabled: false,
            snapshotRetention: 2,
          });
        }),
      );

      expect(updated.volumeId).toEqual(created.volumeId);
      expect(updated.appName).toEqual(created.appName);
      expect(updated.name).toEqual(created.name);
      expect(updated.region).toEqual("iad");
      expect(updated.sizeGb).toEqual(2);
      expect(updated.autoBackupEnabled).toEqual(false);
      expect(updated.snapshotRetention).toEqual(2);

      const refetched = yield* Services.machines.volumesGetById({
        app_name: updated.appName,
        volume_id: updated.volumeId,
      });
      expect(refetched.id).toEqual(created.volumeId);
      expect(refetched.size_gb).toEqual(2);
      expect(refetched.auto_backup_enabled).toEqual(false);
      expect(refetched.snapshot_retention).toEqual(2);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.appName, created.volumeId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!hasFlyCreds)(
  "replace when region changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("ReplaceSite");
          return yield* Fly.Volume("ReplaceData", {
            app,
            region: "iad",
            sizeGb: 1,
          });
        }),
      );

      expect(created.region).toEqual("iad");

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("ReplaceSite");
          return yield* Fly.Volume("ReplaceData", {
            app,
            region: "ewr",
            sizeGb: 1,
          });
        }),
      );

      expect(replaced.volumeId).not.toEqual(created.volumeId);
      expect(replaced.region).toEqual("ewr");
      expect(replaced.appName).toEqual(created.appName);
      expect(replaced.sizeGb).toEqual(1);

      const fetched = yield* Services.machines.volumesGetById({
        app_name: replaced.appName,
        volume_id: replaced.volumeId,
      });
      expect(fetched.id).toEqual(replaced.volumeId);
      expect(fetched.region).toEqual("ewr");

      const oldGone = yield* waitUntilGone(created.appName, created.volumeId);
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.appName, replaced.volumeId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!hasFlyCreds)(
  "list enumerates the deployed volume",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("ListSite");
          return yield* Fly.Volume("ListData", {
            app,
            region: "iad",
            sizeGb: 1,
          });
        }),
      );

      const provider = yield* Provider.findProvider(Fly.Volume);
      const all = yield* provider.list();
      const found = all.find((volume) => volume.volumeId === deployed.volumeId);
      expect(found).toBeDefined();
      expect(found?.appName).toEqual(deployed.appName);
      expect(found?.name).toEqual(deployed.name);
      expect(found?.region).toEqual("iad");
      expect(found?.sizeGb).toEqual(1);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(deployed.appName, deployed.volumeId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
