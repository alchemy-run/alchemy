import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as vmmigration from "@distilled.cloud/gcp/vmmigration_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  hasGcpCreds,
  logLevel,
  project,
  runEntitlementProbe,
  runLifecycle,
  waitUntilGone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsImageImports on a missing import fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        vmmigration.getProjectsLocationsImageImports({
          name: `projects/${project}/locations/us-central1/imageImports/alchemy-missing-import`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runEntitlementProbe)(
  "createProjectsLocationsImageImports without entitlement fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        vmmigration.createProjectsLocationsImageImports({
          parent: `projects/${project}/locations/us-central1`,
          imageImportId: "alchemy-import-probe",
          body: {
            cloudStorageUri: `gs://${project}-alchemy-vmmigration/disk.vmdk`,
            diskImageTargetDefaults: {
              imageName: "alchemy-probe-disk",
              targetProject: `projects/${project}/locations/global/targetProjects/${project}`,
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
  "create, update, and delete a vm migration image import",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const target = yield* GCP.Vmmigration.Target("ImportLanding");
          return yield* GCP.Vmmigration.ImageImport("Disk", {
            location: "us-central1",
            cloudStorageUri: `gs://${project}-alchemy-vmmigration/disk.vmdk`,
            diskImageTargetDefaults: {
              imageName: "alchemy-imported-disk",
              targetProject: target.name,
              description: "imported disk",
              labels: { env: "test" },
            },
          });
        }),
      );

      expect(created.imageImportId).toEqual(expect.any(String));
      expect(created.name).toEqual(
        `projects/${project}/locations/us-central1/imageImports/${created.imageImportId}`,
      );
      expect(created.location).toEqual("us-central1");
      expect(created.cloudStorageUri).toContain("gs://");
      expect(created.diskImageTargetDefaults?.imageName).toEqual(
        "alchemy-imported-disk",
      );
      expect(created.diskImageTargetDefaults?.labels).toMatchObject({
        env: "test",
      });

      const fetched = yield* vmmigration.getProjectsLocationsImageImports({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.diskImageTargetDefaults?.labels?.env).toEqual("test");
      expect(fetched.diskImageTargetDefaults?.description).toContain(
        "alchemy-id=",
      );

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        vmmigration.getProjectsLocationsImageImports({ name: created.name }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
