import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as datamigration from "@distilled.cloud/gcp/datamigration_v1";
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
  "getProjectsLocationsConversionWorkspaces on a missing workspace fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        datamigration.getProjectsLocationsConversionWorkspaces({
          name: `projects/${project}/locations/us-central1/conversionWorkspaces/alchemy-missing-workspace`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runEntitlementProbe)(
  "createProjectsLocationsConversionWorkspaces without entitlement fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        datamigration.createProjectsLocationsConversionWorkspaces({
          parent: `projects/${project}/locations/us-central1`,
          conversionWorkspaceId: "alchemy-workspace-probe",
          body: {
            displayName: "probe",
            source: { engine: "MYSQL", version: "8.0" },
            destination: { engine: "POSTGRESQL", version: "14" },
          },
        }),
      );
      expect(error._tag).toEqual("Forbidden");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a conversion workspace",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Datamigration.ConversionWorkspace("MysqlToPg", {
            location: "us-central1",
            displayName: "mysql-to-pg",
            source: { engine: "MYSQL", version: "8.0" },
            destination: { engine: "POSTGRESQL", version: "14" },
            globalSettings: { skip_triggers: "false" },
          });
        }),
      );

      expect(created.conversionWorkspaceId).toEqual(expect.any(String));
      expect(created.name).toEqual(
        `projects/${project}/locations/us-central1/conversionWorkspaces/${created.conversionWorkspaceId}`,
      );
      expect(created.location).toEqual("us-central1");
      expect(created.displayName).toEqual("mysql-to-pg");
      expect(created.source?.engine).toEqual("MYSQL");
      expect(created.destination?.engine).toEqual("POSTGRESQL");
      expect(created.globalSettings).toMatchObject({ skip_triggers: "false" });

      const fetched =
        yield* datamigration.getProjectsLocationsConversionWorkspaces({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toContain("alchemy-id=");
      expect(fetched.displayName).toContain("mysql-to-pg");
      expect(fetched.source?.engine).toEqual("MYSQL");
      expect(fetched.destination?.version).toEqual("14");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Datamigration.ConversionWorkspace("MysqlToPg", {
            conversionWorkspaceId: created.conversionWorkspaceId,
            location: "us-central1",
            displayName: "mysql-to-pg-v2",
            source: { engine: "MYSQL", version: "8.0" },
            destination: { engine: "POSTGRESQL", version: "14" },
            globalSettings: { skip_triggers: "true" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("mysql-to-pg-v2");
      expect(updated.globalSettings).toMatchObject({ skip_triggers: "true" });

      const fetchedUpdate =
        yield* datamigration.getProjectsLocationsConversionWorkspaces({
          name: updated.name,
        });
      expect(fetchedUpdate.displayName).toContain("mysql-to-pg-v2");
      expect(fetchedUpdate.globalSettings?.skip_triggers).toEqual("true");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        datamigration.getProjectsLocationsConversionWorkspaces({
          name: created.name,
        }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
