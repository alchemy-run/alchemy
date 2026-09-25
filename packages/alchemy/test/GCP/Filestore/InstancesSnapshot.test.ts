import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as file from "@distilled.cloud/gcp/file_v1";
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

// Zonal instance + snapshot each take several minutes; skip unless enabled.
const runLifecycle =
  hasGcpCreds && !!process.env.GCP_TEST_FILESTORE && !process.env.FAST;

const project = process.env.GOOGLE_PROJECT_ID ?? "";

const waitUntilGone = (name: string) =>
  file.getProjectsLocationsInstancesSnapshots({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsInstancesSnapshots on a missing snapshot fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        file.getProjectsLocationsInstancesSnapshots({
          name: `projects/${project}/locations/us-central1-a/instances/alchemy-filestore-missing/snapshots/alchemy-snap-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      const page = yield* file
        .listProjectsLocationsInstancesSnapshots({
          parent: `projects/${project}/locations/-/instances/-`,
          pageSize: 10,
          returnPartialSuccess: true,
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
  "create, update, and delete a filestore snapshot",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const nfs = yield* GCP.Filestore.Instance("Nfs", {
            location: "us-central1-a",
            tier: "ZONAL",
            fileShares: [{ name: "share1", capacityGb: 1024 }],
            networks: [{ network: "default", modes: ["MODE_IPV4"] }],
            labels: { env: "test" },
          });
          const snapshot = yield* GCP.Filestore.InstancesSnapshot("Nightly", {
            instance: nfs.name,
            description: "alchemy-test-snap",
            labels: { env: "test" },
          });
          return { nfs, snapshot };
        }),
      );

      expect(created.snapshot.name).toContain("/snapshots/");
      expect(created.snapshot.snapshotId).toEqual(expect.any(String));
      expect(created.snapshot.instance).toEqual(created.nfs.name);
      expect(created.snapshot.description).toEqual("alchemy-test-snap");
      expect(created.snapshot.labels).toMatchObject({ env: "test" });
      expect(created.snapshot.state).toEqual("READY");

      const fetched = yield* file.getProjectsLocationsInstancesSnapshots({
        name: created.snapshot.name,
      });
      expect(fetched.name).toEqual(created.snapshot.name);
      expect(fetched.description).toEqual("alchemy-test-snap");
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const nfs = yield* GCP.Filestore.Instance("Nfs", {
            instanceId: created.nfs.instanceId,
            location: "us-central1-a",
            tier: "ZONAL",
            fileShares: [{ name: "share1", capacityGb: 1024 }],
            networks: [{ network: "default", modes: ["MODE_IPV4"] }],
            labels: { env: "test" },
          });
          const snapshot = yield* GCP.Filestore.InstancesSnapshot("Nightly", {
            instance: nfs.name,
            snapshotId: created.snapshot.snapshotId,
            description: "alchemy-prod-snap",
            labels: { env: "prod", role: "backup" },
          });
          return { nfs, snapshot };
        }),
      );

      expect(updated.snapshot.name).toEqual(created.snapshot.name);
      expect(updated.snapshot.description).toEqual("alchemy-prod-snap");
      expect(updated.snapshot.labels).toMatchObject({
        env: "prod",
        role: "backup",
      });

      const refetched = yield* file.getProjectsLocationsInstancesSnapshots({
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
