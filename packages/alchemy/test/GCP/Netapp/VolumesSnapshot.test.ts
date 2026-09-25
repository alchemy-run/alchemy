import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as netapp from "@distilled.cloud/gcp/netapp_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

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

// Pool + volume provisioning is multi-minute; skip unless explicitly enabled.
const runLifecycle =
  hasGcpCreds && !!process.env.GCP_TEST_NETAPP && !process.env.FAST;

const project = process.env.GOOGLE_PROJECT_ID ?? "";

const waitUntilGone = (name: string) =>
  netapp.getProjectsLocationsVolumesSnapshots({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsVolumesSnapshots on a missing snapshot fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        netapp.getProjectsLocationsVolumesSnapshots({
          name: `projects/${project}/locations/us-central1/volumes/alchemy-netapp-missing/snapshots/alchemy-snap-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      const page = yield* netapp
        .listProjectsLocationsVolumesSnapshots({
          parent: `projects/${project}/locations/us-central1/volumes/-`,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag(["NotFound", "Forbidden"], () =>
            Effect.succeed({ snapshots: [] as const }),
          ),
        );
      expect(Array.isArray(page.snapshots ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a volume snapshot",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const pool = yield* GCP.Netapp.StoragePool("Pool", {
            location: "us-central1",
            network: "default",
            serviceLevel: "STANDARD",
            capacityGib: 2048,
            labels: { env: "test" },
          });
          const volume = yield* GCP.Netapp.Volume("Share", {
            location: "us-central1",
            storagePool: pool.name,
            protocols: ["NFSV3"],
            capacityGib: 100,
            shareName: "alchsnap",
            labels: { env: "test" },
          });
          const snapshot = yield* GCP.Netapp.VolumesSnapshot("Nightly", {
            volume: volume.name,
            description: "alchemy-test-snap",
            labels: { env: "test" },
          });
          return { pool, volume, snapshot };
        }),
      );

      expect(created.snapshot.name).toContain("/snapshots/");
      expect(created.snapshot.snapshotId).toEqual(expect.any(String));
      expect(created.snapshot.volume).toEqual(created.volume.name);
      expect(created.snapshot.description).toEqual("alchemy-test-snap");
      expect(created.snapshot.labels).toMatchObject({ env: "test" });

      const fetched = yield* netapp.getProjectsLocationsVolumesSnapshots({
        name: created.snapshot.name,
      });
      expect(fetched.name).toEqual(created.snapshot.name);
      expect(fetched.description).toEqual("alchemy-test-snap");
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const pool = yield* GCP.Netapp.StoragePool("Pool", {
            storagePoolId: created.pool.storagePoolId,
            location: "us-central1",
            network: "default",
            serviceLevel: "STANDARD",
            capacityGib: 2048,
            labels: { env: "test" },
          });
          const volume = yield* GCP.Netapp.Volume("Share", {
            volumeId: created.volume.volumeId,
            location: "us-central1",
            storagePool: pool.name,
            protocols: ["NFSV3"],
            capacityGib: 100,
            shareName: "alchsnap",
            labels: { env: "test" },
          });
          const snapshot = yield* GCP.Netapp.VolumesSnapshot("Nightly", {
            volume: volume.name,
            snapshotId: created.snapshot.snapshotId,
            description: "alchemy-prod-snap",
            labels: { env: "prod", role: "backup" },
          });
          return { pool, volume, snapshot };
        }),
      );

      expect(updated.snapshot.name).toEqual(created.snapshot.name);
      expect(updated.snapshot.description).toEqual("alchemy-prod-snap");
      expect(updated.snapshot.labels).toMatchObject({
        env: "prod",
        role: "backup",
      });

      const refetched = yield* netapp.getProjectsLocationsVolumesSnapshots({
        name: created.snapshot.name,
      });
      expect(refetched.description).toEqual("alchemy-prod-snap");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("backup");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.snapshot.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
