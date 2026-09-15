import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

const runLifecycle =
  hasGcpCreds && !!process.env.GCP_TEST_FILESTORE && !process.env.FAST;

test.provider.skipIf(!runLifecycle)(
  "GetInstance invokes the HTTP binding",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const instance = yield* GCP.Filestore.Instance("Nfs", {
            location: "us-central1-a",
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* instance.name;
              const getInstance = yield* GCP.Filestore.GetInstance(instance);
              return Effect.fn(function* () {
                return yield* getInstance();
              });
            }),
          );
          return { instance, live: yield* Probe({}) };
        }),
      );

      expect(out.live.name).toEqual(out.instance.name);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!runLifecycle)(
  "GetBackup invokes the HTTP binding",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const instance = yield* GCP.Filestore.Instance("Nfs", {
            location: "us-central1-a",
            tier: "BASIC_HDD",
            fileShares: [{ name: "share1", capacityGb: 1024 }],
          });
          const backup = yield* GCP.Filestore.Backup("Nightly", {
            sourceInstance: instance.name,
            sourceFileShare: "share1",
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* backup.name;
              const getBackup = yield* GCP.Filestore.GetBackup(backup);
              return Effect.fn(function* () {
                return yield* getBackup();
              });
            }),
          );
          return { backup, live: yield* Probe({}) };
        }),
      );

      expect(out.live.name).toEqual(out.backup.name);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!runLifecycle)(
  "GetInstancesSnapshot invokes the HTTP binding",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const instance = yield* GCP.Filestore.Instance("Nfs", {
            location: "us-central1-a",
            tier: "ZONAL",
            fileShares: [{ name: "share1", capacityGb: 1024 }],
          });
          const snapshot = yield* GCP.Filestore.InstancesSnapshot("Nightly", {
            instance: instance.name,
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* snapshot.name;
              const getSnapshot =
                yield* GCP.Filestore.GetInstancesSnapshot(snapshot);
              return Effect.fn(function* () {
                return yield* getSnapshot();
              });
            }),
          );
          return { snapshot, live: yield* Probe({}) };
        }),
      );

      expect(out.live.name).toEqual(out.snapshot.name);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
