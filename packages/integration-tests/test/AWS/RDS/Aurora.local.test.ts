/**
 * `AWS.RDS.Aurora` migrations under `alchemy dev` (#2997): the cluster is
 * created in the floci emulator with the Data API enabled, so migrations
 * must run over the Data API by default. Floci never reports
 * `HttpEndpointEnabled` and rejects `formatRecordsAs`, so this pins both
 * the documented transport default and the executor's request shape.
 */
import * as AWS from "@alchemy.run/aws";
import * as Endpoint from "@alchemy.run/aws/Endpoint";
import * as Region from "@alchemy.run/aws/Region";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { Credentials } from "@distilled.cloud/aws/Credentials";
import * as rds from "@distilled.cloud/aws/rds";
import * as rdsdata from "@distilled.cloud/aws/rds-data";
import type { RegionName } from "@distilled.cloud/aws/Region";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { FLOCI_ENDPOINT } from "../Local/fixtures/raw.ts";

const { test } = Test.make({ providers: AWS.providers(), dev: true });

const flociContext = Layer.mergeAll(
  Endpoint.of(FLOCI_ENDPOINT),
  Region.of("us-east-1"),
  Layer.succeed(
    Credentials,
    Effect.succeed({
      accessKeyId: Redacted.make("test"),
      secretAccessKey: Redacted.make("test"),
      sessionToken: undefined,
      region: "us-east-1" as RegionName,
    }),
  ),
);

test.provider(
  "dev Aurora applies migrations over the Data API by default, then only pending ones",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const migrationsDir = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-aurora-local-migrations-",
      });
      yield* fs.writeFileString(
        path.join(migrationsDir, "0001_users.sql"),
        "CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT NOT NULL);",
      );

      const program = Effect.gen(function* () {
        const net = yield* AWS.EC2.Network("AuroraLocalNet", { cidrBlock: "10.0.0.0/16" });
        const securityGroup = yield* AWS.EC2.SecurityGroup("AuroraLocalSecurityGroup", {
          vpcId: net.vpcId,
          description: "alchemy Aurora local migrations test",
        });
        // No migrationsTransport: the documented default is "data-api".
        const db = yield* AWS.RDS.Aurora("AuroraLocal", {
          subnetIds: net.privateSubnetIds,
          securityGroupIds: [securityGroup.groupId],
          migrations: Output.asOutput(migrationsDir),
        });
        return {
          clusterArn: db.cluster.dbClusterArn,
          secretArn: db.secret.secretArn,
          writer: db.writer,
        };
      });

      yield* stack.destroy();

      const created = yield* stack.deploy(program);
      expect(created.clusterArn).toContain(":000000000000:");
      expect(created.writer.migrationsTable).toEqual("__alchemy_migrations");
      expect(Object.keys(created.writer.migrationsHashes)).toEqual(["0001_users.sql"]);

      yield* fs.writeFileString(
        path.join(migrationsDir, "0002_posts.sql"),
        "CREATE TABLE posts (id SERIAL PRIMARY KEY, title TEXT NOT NULL);",
      );
      const updated = yield* stack.deploy(program);
      expect(updated.clusterArn).toEqual(created.clusterArn);
      expect(Object.keys(updated.writer.migrationsHashes).sort()).toEqual([
        "0001_users.sql",
        "0002_posts.sql",
      ]);

      // Out-of-band, against the emulator: both tables and both bookkeeping rows.
      const query = (sql: string) =>
        rdsdata
          .executeStatement({
            resourceArn: created.clusterArn,
            secretArn: created.secretArn,
            database: "app",
            sql,
            includeResultMetadata: true,
          })
          .pipe(Effect.map(AWS.RDSData.toRows), Effect.provide(flociContext));
      expect(yield* query("SELECT name FROM __alchemy_migrations ORDER BY id;")).toEqual([
        { name: "0001_users.sql" },
        { name: "0002_posts.sql" },
      ]);
      expect(yield* query("SELECT count(*)::int AS n FROM posts;")).toEqual([{ n: 0 }]);

      // Unchanged redeploy plans no update.
      const plan = yield* stack.plan(program);
      for (const [fqn, resource] of Object.entries(plan.resources)) {
        expect({ fqn, action: resource.action }).toEqual({ fqn, action: "noop" });
      }

      yield* stack.destroy();

      const clusters = yield* rds.describeDBClusters({}).pipe(Effect.provide(flociContext));
      expect(
        (clusters.DBClusters ?? []).filter((c) => c.DBClusterArn === created.clusterArn),
      ).toEqual([]);
    }),
  {
    tags: ["provider:aws", "provider:aws:rds", "local"],
    timeout: 300_000,
  },
);
