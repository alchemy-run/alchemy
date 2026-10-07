import * as dsql from "@distilled.cloud/aws/dsql";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as AWS from "@/AWS";
import { Cluster, ClusterPolicy } from "@/AWS/DSQL";
import { withDsqlAdminClient } from "@/AWS/DSQL/Migrations.ts";
import { makePgMigrationExecutor } from "@/SQL/Migrations/index.ts";
import * as Test from "@/Test/Alchemy";

const { test } = Test.make({ providers: AWS.providers() });

/** Docs-canonical policy: deny non-VPC connections. */
const vpcOnlyPolicy = (exceptions?: string[]) =>
  JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "DenyNonVpcConnect",
        Effect: "Deny",
        Principal: { AWS: "*" },
        Action: ["dsql:DbConnect", "dsql:DbConnectAdmin"],
        Resource: "*",
        Condition: {
          Null: { "aws:SourceVpc": "true" },
          ...(exceptions ? { StringNotEquals: { "aws:PrincipalArn": exceptions } } : {}),
        },
      },
    ],
  });

const getCluster = (identifier: string) =>
  dsql
    .getCluster({ identifier })
    .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(undefined)));

test.provider(
  "create, update deletion protection, delete DSQL cluster",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // create (deletion protection off for test economics)
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cluster("AppDb", {
            tags: { app: "alchemy-test" },
          });
        }),
      );

      expect(created.clusterId).toBeDefined();
      expect(created.clusterArn).toContain(`:cluster/${created.clusterId}`);
      expect(["ACTIVE", "IDLE"]).toContain(created.status);
      expect(created.endpoint).toContain(created.clusterId);
      expect(created.deletionProtectionEnabled).toBe(false);

      // out-of-band verification
      const observed = yield* getCluster(created.clusterId);
      expect(observed?.identifier).toEqual(created.clusterId);
      expect(observed?.deletionProtectionEnabled).toBe(false);

      // update: enable deletion protection
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cluster("AppDb", {
            deletionProtectionEnabled: true,
            tags: { app: "alchemy-test" },
          });
        }),
      );
      expect(updated.clusterId).toEqual(created.clusterId);
      const reobserved = yield* getCluster(created.clusterId);
      expect(reobserved?.deletionProtectionEnabled).toBe(true);

      // attach a resource-based cluster policy (singleton sub-resource)
      const withPolicy = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* Cluster("AppDb", {
            deletionProtectionEnabled: true,
            tags: { app: "alchemy-test" },
          });
          const policy = yield* ClusterPolicy("AppDbPolicy", {
            clusterId: cluster.clusterId,
            policy: vpcOnlyPolicy(),
          });
          return {
            clusterId: cluster.clusterId,
            policyVersion: policy.policyVersion,
          };
        }),
      );
      expect(withPolicy.clusterId).toEqual(created.clusterId);
      expect(withPolicy.policyVersion).toBeDefined();

      // out-of-band verification of the attached document
      const attached = yield* dsql.getClusterPolicy({
        identifier: created.clusterId,
      });
      expect(attached.policy).toContain("DenyNonVpcConnect");
      expect(attached.policyVersion).toEqual(withPolicy.policyVersion);

      // update the policy document in place (version bumps)
      const policyUpdated = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* Cluster("AppDb", {
            deletionProtectionEnabled: true,
            tags: { app: "alchemy-test" },
          });
          const policy = yield* ClusterPolicy("AppDbPolicy", {
            clusterId: cluster.clusterId,
            policy: vpcOnlyPolicy(["arn:aws:iam::123456789012:role/ExceptionRole"]),
          });
          return { policyVersion: policy.policyVersion };
        }),
      );
      expect(policyUpdated.policyVersion).not.toEqual(withPolicy.policyVersion);
      const reattached = yield* dsql.getClusterPolicy({
        identifier: created.clusterId,
      });
      expect(reattached.policy).toContain("ExceptionRole");

      // delete (provider disables deletion protection automatically)
      yield* stack.destroy();
      const gone = yield* getCluster(created.clusterId);
      // A deleted DSQL cluster is either gone or reports DELETING/DELETED.
      expect(gone === undefined || gone.status === "DELETING" || gone.status === "DELETED").toBe(
        true,
      );
    }),
  { tags: ["provider:aws", "provider:aws:dsql", "live"], timeout: 300_000 },
);

test.provider(
  "applies migrations on create, then only pending ones on update",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const migrationsDir = yield* fs.makeTempDirectory({ prefix: "alchemy-dsql-migrations-" });
      yield* fs.writeFileString(
        path.join(migrationsDir, "0001_users.sql"),
        "CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL);",
      );
      const deployCluster = stack.deploy(
        Effect.gen(function* () {
          return yield* Cluster("MigrationsDb", { migrations: migrationsDir });
        }),
      );

      yield* stack.destroy();

      const created = yield* deployCluster;
      expect(created.migrationsTable).toEqual("__alchemy_migrations");
      expect(Object.keys(created.migrationsHashes)).toEqual(["0001_users.sql"]);

      // A new file is pending: only it runs (replaying 0001's bare CREATE
      // TABLE would fail).
      yield* fs.writeFileString(
        path.join(migrationsDir, "0002_posts.sql"),
        "CREATE TABLE posts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text NOT NULL);",
      );
      const updated = yield* deployCluster;
      expect(updated.clusterId).toEqual(created.clusterId);
      expect(Object.keys(updated.migrationsHashes).sort()).toEqual([
        "0001_users.sql",
        "0002_posts.sql",
      ]);

      // Out-of-band: bookkeeping rows and the migrated tables.
      const { applied, tables } = yield* withDsqlAdminClient(created.endpoint, (client) =>
        Effect.gen(function* () {
          const executor = makePgMigrationExecutor(client);
          return {
            applied: yield* executor.query("SELECT name FROM __alchemy_migrations ORDER BY id;"),
            tables: yield* executor.query(
              "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';",
            ),
          };
        }),
      );
      expect(applied.map((row) => row.name)).toEqual(["0001_users.sql", "0002_posts.sql"]);
      expect(tables.map((row) => row.table_name)).toEqual(
        expect.arrayContaining(["users", "posts"]),
      );

      // Editing an applied migration is rejected rather than replayed.
      yield* fs.writeFileString(
        path.join(migrationsDir, "0001_users.sql"),
        "CREATE TABLE users (id uuid PRIMARY KEY, email text NOT NULL);",
      );
      const rewritten = yield* Effect.result(deployCluster);
      expect(Result.isFailure(rewritten)).toBe(true);
      expect(String(Result.isFailure(rewritten) && rewritten.failure)).toContain("0001_users.sql");

      yield* stack.destroy();
      const gone = yield* getCluster(created.clusterId);
      expect(gone === undefined || gone.status === "DELETING" || gone.status === "DELETED").toBe(
        true,
      );
    }),
  { tags: ["provider:aws", "provider:aws:dsql", "live"], timeout: 300_000 },
);
