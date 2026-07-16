import * as AWS from "@/AWS";
import { Network } from "@/AWS/EC2/Network";
import { DBCluster, DBInstance } from "@/AWS/RDS";
import type { DBInstanceProps } from "@/AWS/RDS/DBInstance.ts";
import { DBSubnetGroup } from "@/AWS/RDS/DBSubnetGroup.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Fast, unconditional `diff` checks. These exercise the replacement-set logic
// without provisioning anything (the real lifecycle is multi-minute, gated
// below). `diff` is called with `id`, `olds`, and `news` — the engine wraps
// `news` in `Input` but plain objects resolve fine.
const callDiff = (olds: DBInstanceProps, news: DBInstanceProps) =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(DBInstance);
    return yield* provider.diff!({
      id: "TestInstance",
      fqn: "TestInstance",
      instanceId: "test-instance",
      olds,
      news,
      oldBindings: undefined as never,
      newBindings: undefined as never,
      output: undefined,
    });
  });

const base: DBInstanceProps = {
  dbInstanceIdentifier: "alchemy-rds-instance-diff",
  dbInstanceClass: "db.t3.micro",
  engine: "postgres",
};

test.provider("diff: storage scale is an in-place update", () =>
  Effect.gen(function* () {
    const result = yield* callDiff(
      { ...base, allocatedStorage: 20 },
      { ...base, allocatedStorage: 50 },
    );
    expect(result).toBeUndefined();
  }),
);

test.provider("diff: changing engine forces replacement", () =>
  Effect.gen(function* () {
    const result = yield* callDiff(base, { ...base, engine: "mysql" });
    expect(result).toEqual({ action: "replace" });
  }),
);

test.provider("diff: changing storageEncrypted forces replacement", () =>
  Effect.gen(function* () {
    const result = yield* callDiff(
      { ...base, storageEncrypted: false },
      { ...base, storageEncrypted: true },
    );
    expect(result).toEqual({ action: "replace" });
  }),
);

test.provider("diff: changing masterUsername forces replacement", () =>
  Effect.gen(function* () {
    const result = yield* callDiff(
      { ...base, masterUsername: "admin" },
      { ...base, masterUsername: "root" },
    );
    expect(result).toEqual({ action: "replace" });
  }),
);

// Default (read-only) path: an RDS instance takes many minutes to create and
// delete — far beyond the 240s test budget — so the canonical `list()` test
// here does NOT deploy. It resolves the provider via the typed
// `Provider.findProvider(DBInstance)` helper and calls `list()` directly,
// asserting it returns a well-typed `DBInstance["Attributes"][]`. On a fresh
// account this is typically empty; either way every element must conform to
// the exact `read` shape.
test.provider("list returns well-typed DB instance attributes", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(DBInstance);
    const all = yield* provider.list();

    expect(Array.isArray(all)).toBe(true);

    // Every element must match the exact `Attributes` shape `read` produces.
    for (const instance of all) {
      expect(typeof instance.dbInstanceIdentifier).toBe("string");
      expect(typeof instance.dbInstanceArn).toBe("string");
      expect(Array.isArray(instance.dbParameterGroupNames)).toBe(true);
      expect(typeof instance.tags).toBe("object");
    }
  }),
);

// Full lifecycle is gated: provisioning an Aurora cluster + instance and then
// tearing it down takes many minutes, exceeding the 240s budget. Set
// AWS_TEST_RDS_DBINSTANCE=1 on an account that can afford the wait to run it.
// It deploys a serverless-v2 Aurora cluster + instance and asserts the
// instance appears in the exhaustively-paginated `list()` result.
test.provider.skipIf(!process.env.AWS_TEST_RDS_DBINSTANCE)(
  "list enumerates the deployed DB instance",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const instance = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* DBCluster("ListCluster", {
            engine: "aurora-postgresql",
            engineMode: "provisioned",
            serverlessV2ScalingConfiguration: {
              MinCapacity: 0.5,
              MaxCapacity: 1,
            },
            manageMasterUserPassword: true,
            masterUsername: "alchemy",
          });

          return yield* DBInstance("ListInstance", {
            dbClusterIdentifier: cluster.dbClusterIdentifier,
            dbInstanceClass: "db.serverless",
            engine: "aurora-postgresql",
          });
        }),
      );

      const provider = yield* Provider.findProvider(DBInstance);
      const all = yield* provider.list();

      expect(
        all.some(
          (i) => i.dbInstanceIdentifier === instance.dbInstanceIdentifier,
        ),
      ).toBe(true);

      yield* stack.destroy();
    }),
  { timeout: 1_800_000 },
);

// Full standalone-instance lifecycle, gated behind RDS_TEST_LIFECYCLE=1.
// Provisioning + modifying + deleting a real `db.t3.micro` takes ~10-15 min,
// far beyond the default budget. It creates a gp3 Postgres instance with
// explicit storage/backup knobs, asserts they round-trip, then does an
// in-place modify (allocatedStorage up, backup retention, perf insights) and
// re-reads to assert no replacement occurred (same ARN, same identifier).
test.provider.skipIf(!process.env.RDS_TEST_LIFECYCLE)(
  "standalone instance: create with storage knobs, then in-place modify",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // The testing account has no default VPC/subnets, so provision a
      // production-shaped network (VPC + subnets across 2 AZs) and a DB subnet
      // group for the instance to live in.
      const network = Effect.gen(function* () {
        const net = yield* Network("RdsNet", { cidrBlock: "10.41.0.0/16" });
        // No fixed name — let the engine generate a unique physical name so a
        // leftover group from an interrupted run can't force a cross-VPC
        // ModifyDBSubnetGroup ("new Subnets are not in the same Vpc").
        const subnetGroup = yield* DBSubnetGroup("RdsSubnetGroup", {
          description: "alchemy standalone instance lifecycle",
          subnetIds: net.privateSubnetIds,
        });
        return { dbSubnetGroupName: subnetGroup.dbSubnetGroupName };
      });

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const { dbSubnetGroupName } = yield* network;
          return yield* DBInstance("StandaloneInstance", {
            dbInstanceIdentifier: "alchemy-rds-standalone",
            engine: "postgres",
            dbInstanceClass: "db.t3.micro",
            allocatedStorage: 20,
            storageType: "gp3",
            masterUsername: "alchemy",
            manageMasterUserPassword: true,
            backupRetentionPeriod: 1,
            deletionProtection: false,
            dbSubnetGroupName,
            publiclyAccessible: false,
          });
        }),
      );

      expect(created.allocatedStorage).toBe(20);
      expect(created.storageType).toBe("gp3");
      expect(created.backupRetentionPeriod).toBe(1);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const { dbSubnetGroupName } = yield* network;
          return yield* DBInstance("StandaloneInstance", {
            dbInstanceIdentifier: "alchemy-rds-standalone",
            engine: "postgres",
            dbInstanceClass: "db.t3.micro",
            allocatedStorage: 25,
            storageType: "gp3",
            masterUsername: "alchemy",
            manageMasterUserPassword: true,
            backupRetentionPeriod: 3,
            enablePerformanceInsights: true,
            deletionProtection: false,
            dbSubnetGroupName,
            publiclyAccessible: false,
          });
        }),
      );

      // In-place modify — identity is preserved (no replacement).
      expect(updated.dbInstanceArn).toBe(created.dbInstanceArn);
      expect(updated.backupRetentionPeriod).toBe(3);

      yield* stack.destroy();
    }),
  { timeout: 2_400_000 },
);
