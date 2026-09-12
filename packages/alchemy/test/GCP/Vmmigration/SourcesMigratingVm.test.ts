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
  "getProjectsLocationsSourcesMigratingVms on a missing vm fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        vmmigration.getProjectsLocationsSourcesMigratingVms({
          name: `projects/${project}/locations/us-central1/sources/alchemy-missing-source/migratingVms/alchemy-missing-vm`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runEntitlementProbe)(
  "createProjectsLocationsSourcesMigratingVms without entitlement fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        vmmigration.createProjectsLocationsSourcesMigratingVms({
          parent: `projects/${project}/locations/us-central1/sources/alchemy-missing-source`,
          migratingVmId: "alchemy-vm-probe",
          body: {
            sourceVmId: "i-0123456789abcdef0",
            displayName: "probe",
            computeEngineTargetDefaults: {
              vmName: "probe",
              machineType: "n2-standard-2",
              zone: "us-central1-a",
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
  "create, update, and delete a vm migration migrating vm",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const source = yield* GCP.Vmmigration.Source("VmSource", {
            aws: dummyAws,
          });
          const target = yield* GCP.Vmmigration.Target("VmLanding");
          return yield* GCP.Vmmigration.SourcesMigratingVm("Web", {
            source: source.name,
            sourceVmId: "i-0123456789abcdef0",
            displayName: "web-1",
            description: "web tier",
            labels: { env: "test" },
            computeEngineTargetDefaults: {
              vmName: "web-1",
              machineType: "n2-standard-2",
              zone: "us-central1-a",
              targetProject: target.name,
            },
          });
        }),
      );

      expect(created.migratingVmId).toEqual(expect.any(String));
      expect(created.name).toContain("/migratingVms/");
      expect(created.sourceVmId).toEqual("i-0123456789abcdef0");
      expect(created.displayName).toEqual("web-1");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* vmmigration.getProjectsLocationsSourcesMigratingVms({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const source = yield* GCP.Vmmigration.Source("VmSource", {
            aws: dummyAws,
          });
          const target = yield* GCP.Vmmigration.Target("VmLanding");
          return yield* GCP.Vmmigration.SourcesMigratingVm("Web", {
            source: source.name,
            migratingVmId: created.migratingVmId,
            sourceVmId: "i-0123456789abcdef0",
            displayName: "web-1-v2",
            description: "web tier v2",
            labels: { env: "prod" },
            computeEngineTargetDefaults: {
              vmName: "web-1",
              machineType: "n2-standard-4",
              zone: "us-central1-a",
              targetProject: target.name,
            },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("web-1-v2");
      expect(updated.labels).toMatchObject({ env: "prod" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        vmmigration.getProjectsLocationsSourcesMigratingVms({
          name: created.name,
        }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
