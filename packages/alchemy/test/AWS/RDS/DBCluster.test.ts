import * as AWS from "@/AWS";
import { Network } from "@/AWS/EC2/Network";
import { DBCluster } from "@/AWS/RDS/DBCluster.ts";
import type { DBClusterProps } from "@/AWS/RDS/DBCluster.ts";
import { DBSubnetGroup } from "@/AWS/RDS/DBSubnetGroup.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Fast, unconditional `diff` checks for the replacement-set logic. No deploy.
const callDiff = (olds: DBClusterProps, news: DBClusterProps) =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(DBCluster);
    return yield* provider.diff!({
      id: "TestCluster",
      instanceId: "test-cluster",
      olds,
      news,
      oldBindings: undefined as never,
      newBindings: undefined as never,
      output: undefined,
    });
  });

const base: DBClusterProps = {
  dbClusterIdentifier: "alchemy-rds-cluster-diff",
  engine: "aurora-postgresql",
};

test.provider("diff: backup retention is an in-place update", () =>
  Effect.gen(function* () {
    const result = yield* callDiff(
      { ...base, backupRetentionPeriod: 1 },
      { ...base, backupRetentionPeriod: 7 },
    );
    expect(result).toBeUndefined();
  }),
);

test.provider("diff: changing databaseName forces replacement", () =>
  Effect.gen(function* () {
    const result = yield* callDiff(
      { ...base, databaseName: "app" },
      { ...base, databaseName: "other" },
    );
    expect(result).toEqual({ action: "replace" });
  }),
);

test.provider("diff: changing kmsKeyId forces replacement", () =>
  Effect.gen(function* () {
    const result = yield* callDiff(
      { ...base, kmsKeyId: "key-a" },
      { ...base, kmsKeyId: "key-b" },
    );
    expect(result).toEqual({ action: "replace" });
  }),
);

test.provider("diff: changing engineMode forces replacement", () =>
  Effect.gen(function* () {
    const result = yield* callDiff(
      { ...base, engineMode: "provisioned" },
      { ...base, engineMode: "serverless" },
    );
    expect(result).toEqual({ action: "replace" });
  }),
);

// Read-only `list()` test (no deploy). An Aurora DB cluster takes MANY minutes
// to create *and* delete — far beyond the 240s test budget — so we exercise the
// enumeration path without provisioning. We resolve the provider via the typed
// `Provider.findProvider(DBCluster)` so `list()`'s element type is the exact
// `DBCluster["Attributes"]` shape, call it, and assert it returns a well-typed
// array (likely empty in a clean test account). This proves the paginated
// `describeDBClusters` -> Attributes mapping compiles and runs.
test.provider("list returns a typed DBCluster Attributes array", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(DBCluster);
    const all = yield* provider.list();

    expect(Array.isArray(all)).toBe(true);
    for (const cluster of all) {
      expect(typeof cluster.dbClusterIdentifier).toBe("string");
      expect(typeof cluster.dbClusterArn).toBe("string");
      expect(typeof cluster.engine).toBe("string");
      expect(typeof cluster.tags).toBe("object");
      expect(Array.isArray(cluster.vpcSecurityGroupIds)).toBe(true);
    }
  }),
);

// Full deploy-based `list()` test, gated behind AWS_TEST_RDS_DBCLUSTER=1.
// Reason: an Aurora cluster create + delete spans many minutes, blowing past
// the 240s budget, so it is opt-in only. When enabled, it deploys a real
// cluster and asserts the deployed identifier appears in the exhaustively
// paginated `list()` result.
test.provider.skipIf(!process.env.AWS_TEST_RDS_DBCLUSTER)(
  "list enumerates the deployed DB cluster",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const cluster = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* DBCluster("ListCluster", {
            engine: "aurora-postgresql",
            engineMode: "provisioned",
            serverlessV2ScalingConfiguration: {
              MinCapacity: 0.5,
              MaxCapacity: 1,
            },
            manageMasterUserPassword: true,
            masterUsername: "alchemy",
          });
        }),
      );

      const provider = yield* Provider.findProvider(DBCluster);
      const all = yield* provider.list();

      expect(
        all.some((c) => c.dbClusterIdentifier === cluster.dbClusterIdentifier),
      ).toBe(true);

      yield* stack.destroy();
    }),
  { timeout: 1_800_000 },
);

// Full cluster lifecycle gated behind RDS_TEST_LIFECYCLE=1. Creates a
// serverless-v2 Aurora cluster with backup/log/deletion-protection knobs, then
// does an in-place modify (backup retention, toggle deletionProtection — a
// regression for the previously-missing `modifyDBCluster` deletion-protection
// sync — and scaling min/max), asserting no replacement (same ARN).
test.provider.skipIf(!process.env.RDS_TEST_LIFECYCLE)(
  "cluster: create with knobs, then in-place modify (deletionProtection toggle)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // No default VPC/subnets in the testing account — provision a
      // production-shaped network (VPC + subnets across 2 AZs) + a DB subnet
      // group for the cluster.
      const network = Effect.gen(function* () {
        const net = yield* Network("ClusterNet", { cidrBlock: "10.42.0.0/16" });
        // No fixed name — let the engine generate a unique physical name so a
        // leftover group from an interrupted run can't force a cross-VPC
        // ModifyDBSubnetGroup ("new Subnets are not in the same Vpc").
        const subnetGroup = yield* DBSubnetGroup("ClusterSubnetGroup", {
          description: "alchemy cluster lifecycle",
          subnetIds: net.privateSubnetIds,
        });
        return { dbSubnetGroupName: subnetGroup.dbSubnetGroupName };
      });

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const { dbSubnetGroupName } = yield* network;
          return yield* DBCluster("LifecycleCluster", {
            dbClusterIdentifier: "alchemy-rds-lifecycle",
            engine: "aurora-postgresql",
            engineMode: "provisioned",
            dbSubnetGroupName,
            serverlessV2ScalingConfiguration: {
              MinCapacity: 0.5,
              MaxCapacity: 1,
            },
            manageMasterUserPassword: true,
            masterUsername: "alchemy",
            backupRetentionPeriod: 1,
            enableCloudwatchLogsExports: ["postgresql"],
            deletionProtection: false,
          });
        }),
      );

      expect(created.backupRetentionPeriod).toBe(1);
      expect(created.enabledCloudwatchLogsExports).toContain("postgresql");
      expect(created.deletionProtection).toBe(false);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const { dbSubnetGroupName } = yield* network;
          return yield* DBCluster("LifecycleCluster", {
            dbClusterIdentifier: "alchemy-rds-lifecycle",
            engine: "aurora-postgresql",
            engineMode: "provisioned",
            dbSubnetGroupName,
            serverlessV2ScalingConfiguration: {
              MinCapacity: 1,
              MaxCapacity: 2,
            },
            manageMasterUserPassword: true,
            masterUsername: "alchemy",
            backupRetentionPeriod: 3,
            enableCloudwatchLogsExports: ["postgresql"],
            deletionProtection: true,
          });
        }),
      );

      expect(updated.dbClusterArn).toBe(created.dbClusterArn);
      expect(updated.backupRetentionPeriod).toBe(3);
      expect(updated.deletionProtection).toBe(true);

      // Re-disable protection so the trailing destroy can delete the cluster.
      yield* stack.deploy(
        Effect.gen(function* () {
          const { dbSubnetGroupName } = yield* network;
          return yield* DBCluster("LifecycleCluster", {
            dbClusterIdentifier: "alchemy-rds-lifecycle",
            engine: "aurora-postgresql",
            engineMode: "provisioned",
            dbSubnetGroupName,
            serverlessV2ScalingConfiguration: {
              MinCapacity: 1,
              MaxCapacity: 2,
            },
            manageMasterUserPassword: true,
            masterUsername: "alchemy",
            backupRetentionPeriod: 3,
            enableCloudwatchLogsExports: ["postgresql"],
            deletionProtection: false,
          });
        }),
      );

      yield* stack.destroy();
    }),
  { timeout: 2_400_000 },
);
