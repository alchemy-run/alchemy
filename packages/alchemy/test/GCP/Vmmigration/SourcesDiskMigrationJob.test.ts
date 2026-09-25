import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as vmmigration from "@distilled.cloud/gcp/vmmigration_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  dummyAws,
  hasGcpCreds,
  logLevel,
  project,
  runEntitlementProbe,
  runLifecycle,
  waitUntilGone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsSourcesDiskMigrationJobs on a missing job fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        vmmigration.getProjectsLocationsSourcesDiskMigrationJobs({
          name: `projects/${project}/locations/us-central1/sources/alchemy-missing-source/diskMigrationJobs/alchemy-missing-job`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runEntitlementProbe)(
  "createProjectsLocationsSourcesDiskMigrationJobs without entitlement fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        vmmigration.createProjectsLocationsSourcesDiskMigrationJobs({
          parent: `projects/${project}/locations/us-central1/sources/alchemy-missing-source`,
          diskMigrationJobId: "alchemy-disk-probe",
          body: {
            awsSourceDiskDetails: { volumeId: "vol-0123456789abcdef0" },
            targetDetails: {
              targetProject: `projects/${project}/locations/global/targetProjects/${project}`,
              targetDisk: {
                zone: `projects/${project}/locations/us-central1-a`,
                diskType: "COMPUTE_ENGINE_DISK_TYPE_STANDARD",
                diskId: "alchemy-probe-disk",
              },
            },
          },
        }),
      );
      expect(["Forbidden", "NotFound", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a vm migration disk migration job",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const source = yield* GCP.Vmmigration.Source("DiskSource", {
            aws: dummyAws,
          });
          const target = yield* GCP.Vmmigration.Target("DiskLanding");
          return yield* GCP.Vmmigration.SourcesDiskMigrationJob("Boot", {
            source: source.name,
            awsSourceDiskDetails: { volumeId: "vol-0123456789abcdef0" },
            targetDetails: {
              targetProject: target.name,
              targetDisk: {
                zone: `projects/${project}/locations/us-central1-a`,
                diskType: "COMPUTE_ENGINE_DISK_TYPE_STANDARD",
                diskId: "alchemy-imported-boot",
              },
              labels: { env: "test" },
            },
          });
        }),
      );

      expect(created.diskMigrationJobId).toEqual(expect.any(String));
      expect(created.name).toContain("/diskMigrationJobs/");
      expect(created.awsSourceDiskDetails?.volumeId).toEqual(
        "vol-0123456789abcdef0",
      );
      expect(created.targetDetails?.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* vmmigration.getProjectsLocationsSourcesDiskMigrationJobs({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.targetDetails?.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const source = yield* GCP.Vmmigration.Source("DiskSource", {
            aws: dummyAws,
          });
          const target = yield* GCP.Vmmigration.Target("DiskLanding");
          return yield* GCP.Vmmigration.SourcesDiskMigrationJob("Boot", {
            source: source.name,
            diskMigrationJobId: created.diskMigrationJobId,
            awsSourceDiskDetails: { volumeId: "vol-0123456789abcdef0" },
            targetDetails: {
              targetProject: target.name,
              targetDisk: {
                zone: `projects/${project}/locations/us-central1-a`,
                diskType: "COMPUTE_ENGINE_DISK_TYPE_SSD",
                diskId: "alchemy-imported-boot",
              },
              labels: { env: "prod" },
            },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.targetDetails?.labels).toMatchObject({ env: "prod" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        vmmigration.getProjectsLocationsSourcesDiskMigrationJobs({
          name: created.name,
        }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
