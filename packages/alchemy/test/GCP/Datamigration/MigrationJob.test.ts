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
  runSlowLifecycle,
  waitUntilGone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsMigrationJobs on a missing job fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        datamigration.getProjectsLocationsMigrationJobs({
          name: `projects/${project}/locations/us-central1/migrationJobs/alchemy-missing-job`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runEntitlementProbe)(
  "createProjectsLocationsMigrationJobs without entitlement fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        datamigration.createProjectsLocationsMigrationJobs({
          parent: `projects/${project}/locations/us-central1`,
          migrationJobId: "alchemy-job-probe",
          body: {
            displayName: "probe",
            type: "ONE_TIME",
            source: `projects/${project}/locations/us-central1/connectionProfiles/alchemy-missing-src`,
            destination: `projects/${project}/locations/us-central1/connectionProfiles/alchemy-missing-dest`,
          },
        }),
      );
      expect(["Forbidden", "NotFound", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runSlowLifecycle)(
  "create, update, and delete a mysql to cloudsql migration job",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const source = yield* GCP.Datamigration.ConnectionProfile(
            "MysqlSrc",
            {
              location: "us-central1",
              displayName: "job-src",
              mysql: {
                host: "10.0.0.8",
                port: 3306,
                username: "alchemy",
                password: "AlchemyTestPass1",
              },
            },
          );
          const dest = yield* GCP.Datamigration.ConnectionProfile("MysqlDest", {
            location: "us-central1",
            displayName: "job-dest",
            cloudsql: {
              settings: {
                sourceId: source.name,
                databaseVersion: "MYSQL_8_0",
                tier: "db-n1-standard-1",
                rootPassword: "AlchemyTestPass1",
                dataDiskSizeGb: "10",
              },
            },
          });
          const job = yield* GCP.Datamigration.MigrationJob("Replica", {
            location: "us-central1",
            displayName: "mysql-replica",
            labels: { env: "test" },
            type: "CONTINUOUS",
            source: source.name,
            destination: dest.name,
            staticIpConnectivity: {},
          });
          return { source, dest, job };
        }),
      );

      expect(created.job.migrationJobId).toEqual(expect.any(String));
      expect(created.job.name).toEqual(
        `projects/${project}/locations/us-central1/migrationJobs/${created.job.migrationJobId}`,
      );
      expect(created.job.type).toEqual("CONTINUOUS");
      expect(created.job.source).toEqual(created.source.name);
      expect(created.job.destination).toEqual(created.dest.name);
      expect(created.job.labels).toMatchObject({ env: "test" });

      const fetched = yield* datamigration.getProjectsLocationsMigrationJobs({
        name: created.job.name,
      });
      expect(fetched.name).toEqual(created.job.name);
      expect(fetched.displayName).toEqual("mysql-replica");
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const source = yield* GCP.Datamigration.ConnectionProfile(
            "MysqlSrc",
            {
              connectionProfileId: created.source.connectionProfileId,
              location: "us-central1",
              displayName: "job-src",
              mysql: {
                host: "10.0.0.8",
                port: 3306,
                username: "alchemy",
              },
            },
          );
          const dest = yield* GCP.Datamigration.ConnectionProfile("MysqlDest", {
            connectionProfileId: created.dest.connectionProfileId,
            location: "us-central1",
            displayName: "job-dest",
            cloudsql: {
              settings: {
                sourceId: source.name,
                databaseVersion: "MYSQL_8_0",
                tier: "db-n1-standard-1",
                dataDiskSizeGb: "10",
              },
            },
          });
          const job = yield* GCP.Datamigration.MigrationJob("Replica", {
            migrationJobId: created.job.migrationJobId,
            location: "us-central1",
            displayName: "mysql-replica-v2",
            labels: { env: "prod", team: "dms" },
            type: "CONTINUOUS",
            source: source.name,
            destination: dest.name,
            staticIpConnectivity: {},
          });
          return { source, dest, job };
        }),
      );

      expect(updated.job.name).toEqual(created.job.name);
      expect(updated.job.displayName).toEqual("mysql-replica-v2");
      expect(updated.job.labels).toMatchObject({ env: "prod", team: "dms" });

      const fetchedUpdate =
        yield* datamigration.getProjectsLocationsMigrationJobs({
          name: updated.job.name,
        });
      expect(fetchedUpdate.displayName).toEqual("mysql-replica-v2");
      expect(fetchedUpdate.labels?.team).toEqual("dms");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        datamigration.getProjectsLocationsMigrationJobs({
          name: created.job.name,
        }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
