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
  "getProjectsLocationsConnectionProfiles on a missing profile fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        datamigration.getProjectsLocationsConnectionProfiles({
          name: `projects/${project}/locations/us-central1/connectionProfiles/alchemy-missing-profile`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runEntitlementProbe)(
  "createProjectsLocationsConnectionProfiles without entitlement fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        datamigration.createProjectsLocationsConnectionProfiles({
          parent: `projects/${project}/locations/us-central1`,
          connectionProfileId: "alchemy-profile-probe",
          body: {
            displayName: "probe",
            mysql: {
              host: "10.0.0.8",
              port: 3306,
              username: "alchemy",
              password: "AlchemyTestPass1",
            },
          },
        }),
      );
      expect(error._tag).toEqual("Forbidden");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a mysql connection profile",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Datamigration.ConnectionProfile("MysqlSrc", {
            location: "us-central1",
            displayName: "mysql-src",
            labels: { env: "test" },
            mysql: {
              host: "10.0.0.8",
              port: 3306,
              username: "alchemy",
              password: "AlchemyTestPass1",
            },
          });
        }),
      );

      expect(created.connectionProfileId).toEqual(expect.any(String));
      expect(created.name).toEqual(
        `projects/${project}/locations/us-central1/connectionProfiles/${created.connectionProfileId}`,
      );
      expect(created.location).toEqual("us-central1");
      expect(created.displayName).toEqual("mysql-src");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.mysql?.host).toEqual("10.0.0.8");
      expect(created.mysql?.port).toEqual(3306);
      expect(created.mysql?.username).toEqual("alchemy");
      expect(created.mysql?.password).toBeUndefined();

      const fetched =
        yield* datamigration.getProjectsLocationsConnectionProfiles({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toEqual("mysql-src");
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.mysql?.host).toEqual("10.0.0.8");
      expect(fetched.mysql?.password).toBeUndefined();

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Datamigration.ConnectionProfile("MysqlSrc", {
            connectionProfileId: created.connectionProfileId,
            location: "us-central1",
            displayName: "mysql-src-v2",
            labels: { env: "prod", team: "dms" },
            mysql: {
              host: "10.0.0.8",
              port: 3306,
              username: "alchemy",
            },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("mysql-src-v2");
      expect(updated.labels).toMatchObject({ env: "prod", team: "dms" });

      const fetchedUpdate =
        yield* datamigration.getProjectsLocationsConnectionProfiles({
          name: updated.name,
        });
      expect(fetchedUpdate.displayName).toEqual("mysql-src-v2");
      expect(fetchedUpdate.labels?.team).toEqual("dms");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        datamigration.getProjectsLocationsConnectionProfiles({
          name: created.name,
        }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
