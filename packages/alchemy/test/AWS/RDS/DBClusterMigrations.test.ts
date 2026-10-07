import * as rdsdata from "@distilled.cloud/aws/rds-data";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as AWS from "@/AWS";
import { Network } from "@/AWS/EC2/Network";
import { SecurityGroup } from "@/AWS/EC2/SecurityGroup";
import { Aurora } from "@/AWS/RDS/Aurora.ts";
import * as Test from "@/Test/Alchemy";

const { test } = Test.make({ providers: AWS.providers() });

// An Aurora cluster plus writer takes ~15+ minutes to create and delete,
// far beyond the default test budget.
test.provider.skipIf(!process.env.AWS_TEST_RDS_DBCLUSTER)(
  "Aurora applies migrations over the Data API, then only pending ones",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const migrationsDir = yield* fs.makeTempDirectory({ prefix: "alchemy-aurora-migrations-" });
      yield* fs.writeFileString(
        path.join(migrationsDir, "0001_users.sql"),
        "CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT NOT NULL);",
      );
      const deployDb = stack.deploy(
        Effect.gen(function* () {
          const net = yield* Network("MigrationsNet", { cidrBlock: "10.43.0.0/16" });
          const securityGroup = yield* SecurityGroup("MigrationsDbSecurityGroup", {
            vpcId: net.vpcId,
            description: "alchemy Aurora migrations test",
          });
          const db = yield* Aurora("MigrationsDb", {
            subnetIds: net.privateSubnetIds,
            securityGroupIds: [securityGroup.groupId],
            migrations: migrationsDir,
          });
          return {
            clusterArn: db.cluster.dbClusterArn,
            secretArn: db.secret.secretArn,
            migrations: db.migrations!,
          };
        }),
      );

      yield* stack.destroy();

      const created = yield* deployDb;
      expect(created.migrations.database).toEqual("app");
      expect(created.migrations.migrationsTable).toEqual("__alchemy_migrations");
      expect(Object.keys(created.migrations.migrationsHashes)).toEqual(["0001_users.sql"]);

      yield* fs.writeFileString(
        path.join(migrationsDir, "0002_posts.sql"),
        "CREATE TABLE posts (id SERIAL PRIMARY KEY, title TEXT NOT NULL);",
      );
      const updated = yield* deployDb;
      expect(updated.clusterArn).toEqual(created.clusterArn);
      expect(Object.keys(updated.migrations.migrationsHashes).sort()).toEqual([
        "0001_users.sql",
        "0002_posts.sql",
      ]);

      // Out-of-band: the bookkeeping rows via the Data API.
      const applied = yield* rdsdata.executeStatement({
        resourceArn: created.clusterArn,
        secretArn: created.secretArn,
        database: "app",
        sql: "SELECT name FROM __alchemy_migrations ORDER BY id;",
        formatRecordsAs: "JSON",
      });
      expect(JSON.parse(applied.formattedRecords ?? "[]")).toEqual([
        { name: "0001_users.sql" },
        { name: "0002_posts.sql" },
      ]);

      yield* stack.destroy();
    }),
  { tags: ["provider:aws", "provider:aws:ec2", "provider:aws:rds", "live"], timeout: 2_400_000 },
);
