import * as AWS from "@/AWS";
import { Network } from "@/AWS/EC2/Network";
import { DBCluster, DBInstance } from "@/AWS/RDS";
import * as Drift from "@/Drift";
import { DBSubnetGroup } from "@/AWS/RDS/DBSubnetGroup.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as rds from "@distilled.cloud/aws/rds";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Render a deploy failure (whatever engine wrapper it arrives in) to a string
// we can assert AWS's parameter-validation message against.
const renderFailure = (attempt: Result.Result<unknown, unknown>): string => {
  if (!Result.isFailure(attempt)) {
    return "";
  }
  const failure = attempt.failure;
  const json = (() => {
    try {
      return JSON.stringify(failure);
    } catch {
      return "";
    }
  })();
  return `${String(failure)} ${json}`;
};

// Live wire probes for this PR's Redacted/Duration prop conversions on
// DBInstance (the instance reconcile has its own conversion code, separate
// from DBCluster's). Both drive the full engine + provider `reconcile` path
// into a real `createDBInstance` call that AWS rejects at
// parameter-validation time — nothing is provisioned and the probe completes
// in seconds. Probe 1 proves `masterUserPassword: Redacted.Redacted<string>`
// serializes to the actual secret characters on the wire; probe 2 proves
// `backupRetentionPeriod: Duration.Input` ("60 days") arrives as integer days
// (rejected as > the 35-day maximum). These rejected requests do not verify
// the RDS_TEST_LIFECYCLE-gated storage lifecycle below.
test.provider(
  "wire probe: Redacted password + Duration retention reach createDBInstance",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const badPassword = yield* Effect.result(
        stack.deploy(
          Effect.gen(function* () {
            return yield* DBInstance("AuditProbeInstance", {
              dbInstanceIdentifier: "alchemy-audit-probe-instance",
              engine: "postgres",
              dbInstanceClass: "db.t3.micro",
              allocatedStorage: 20,
              masterUsername: "alchemy",
              // '@' and ' ' are forbidden password characters — AWS rejects
              // the create before provisioning anything.
              masterUserPassword: Redacted.make("bad@pass word1"),
              backupRetentionPeriod: "3 days",
            });
          }),
        ),
      );
      expect(Result.isFailure(badPassword)).toBe(true);
      expect(renderFailure(badPassword)).toContain("InvalidParameterValue");
      expect(renderFailure(badPassword)).toContain("MasterUserPassword");

      const badRetention = yield* Effect.result(
        stack.deploy(
          Effect.gen(function* () {
            return yield* DBInstance("AuditProbeInstance", {
              dbInstanceIdentifier: "alchemy-audit-probe-instance",
              engine: "postgres",
              dbInstanceClass: "db.t3.micro",
              allocatedStorage: 20,
              masterUsername: "alchemy",
              masterUserPassword: Redacted.make("ValidPassw0rd"),
              // 60 days is above the 1-35 day API maximum — AWS can only
              // reject it if the converted integer arrived on the wire.
              backupRetentionPeriod: "60 days",
            });
          }),
        ),
      );
      expect(Result.isFailure(badRetention)).toBe(true);
      expect(renderFailure(badRetention)).toContain("InvalidParameterValue");
      expect(renderFailure(badRetention)).toMatch(/retention/i);

      yield* stack.destroy();
    }),
  { timeout: 120_000 },
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
  { timeout: 120_000 },
);

// RDS provisioning and storage optimization exceed the default test budget.
test.provider.skipIf(!process.env.RDS_TEST_LIFECYCLE)(
  "standalone instance: autoscaling defaults, drift, and allocation floor",
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

      const program = (
        allocatedStorage: number,
        maxAllocatedStorage?: number,
        backupRetentionPeriod: "1 day" | "3 days" = "1 day",
        enablePerformanceInsights = false,
      ) =>
        Effect.gen(function* () {
          const { dbSubnetGroupName } = yield* network;
          return yield* DBInstance("StandaloneInstance", {
            engine: "postgres",
            dbInstanceClass: "db.t3.micro",
            allocatedStorage,
            ...(maxAllocatedStorage === undefined
              ? {}
              : { maxAllocatedStorage }),
            storageType: "gp2",
            masterUsername: "alchemy",
            manageMasterUserPassword: true,
            backupRetentionPeriod,
            enablePerformanceInsights,
            deletionProtection: false,
            dbSubnetGroupName,
            publiclyAccessible: false,
          });
        });
      const created = yield* stack.deploy(program(20));
      expect(created.allocatedStorage).toBe(20);
      expect(created.storageType).toBe("gp2");
      expect(created.backupRetentionPeriod).toBe(1);
      expect([0, 20]).toContain(created.maxAllocatedStorage ?? 0);
      const describe = rds.describeDBInstances({
        DBInstanceIdentifier: created.dbInstanceIdentifier,
      });
      expect([0, 20]).toContain(
        (yield* describe).DBInstances?.[0]?.MaxAllocatedStorage ?? 0,
      );

      const enabled = yield* stack.deploy(program(20, 40));
      expect(enabled.maxAllocatedStorage).toBe(40);
      expect((yield* describe).DBInstances?.[0]?.MaxAllocatedStorage).toBe(40);
      // Grow beyond the old ceiling while disabling autoscaling in the same request.
      const updated = yield* stack.deploy(
        program(50, undefined, "3 days", true),
      );
      expect(updated.dbInstanceArn).toBe(created.dbInstanceArn);
      expect(updated.backupRetentionPeriod).toBe(3);
      expect(updated.allocatedStorage).toBe(50);
      expect([0, 50]).toContain(updated.maxAllocatedStorage ?? 0);
      const grown = (yield* describe).DBInstances?.[0];
      expect(grown?.AllocatedStorage).toBe(50);
      expect([0, 50]).toContain(grown?.MaxAllocatedStorage ?? 0);
      expect(grown?.PendingModifiedValues?.AllocatedStorage).toBeUndefined();

      const explicit = program(20, 100, "3 days", true);
      const reenabled = yield* stack.deploy(explicit);
      expect(reenabled.allocatedStorage).toBe(50);
      expect(reenabled.maxAllocatedStorage).toBe(100);
      expect((yield* describe).DBInstances?.[0]?.MaxAllocatedStorage).toBe(100);

      const injectCeiling = Effect.fn(function* (ceiling: number) {
        yield* rds.modifyDBInstance({
          DBInstanceIdentifier: created.dbInstanceIdentifier,
          MaxAllocatedStorage: ceiling,
          ApplyImmediately: true,
        });
        const injected = yield* describe.pipe(
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            times: 8,
            until: (response) =>
              response.DBInstances?.[0]?.MaxAllocatedStorage === ceiling,
          }),
        );
        expect(injected.DBInstances?.[0]?.MaxAllocatedStorage).toBe(ceiling);
      });
      yield* injectCeiling(120);
      expect(
        (yield* stack.plan(explicit)).resources.StandaloneInstance,
      ).toMatchObject({
        action: "update",
      });
      const repairedExplicit = yield* stack.deploy(explicit);
      expect(repairedExplicit.maxAllocatedStorage).toBe(100);
      expect((yield* describe).DBInstances?.[0]?.MaxAllocatedStorage).toBe(100);

      // Lowering the minimum cannot shrink capacity, but omission disables autoscaling.
      const lowerMinimum = program(20);
      expect(
        (yield* stack.plan(lowerMinimum)).resources.StandaloneInstance,
      ).toMatchObject({
        action: "update",
      });
      const preserved = yield* stack.deploy(lowerMinimum);
      expect(preserved.dbInstanceArn).toBe(created.dbInstanceArn);
      expect(preserved.allocatedStorage).toBe(50);
      expect([0, 50]).toContain(preserved.maxAllocatedStorage ?? 0);
      const observed = (yield* describe).DBInstances?.[0];
      expect(observed?.AllocatedStorage).toBe(50);
      expect([0, 50]).toContain(observed?.MaxAllocatedStorage ?? 0);
      expect(observed?.PendingModifiedValues?.AllocatedStorage).toBeUndefined();

      yield* injectCeiling(80);
      const drift = yield* Drift.detect({
        name: stack.name,
        stage: stack.stage,
      });
      expect(drift.resources.StandaloneInstance?.action).toBe("drifted");
      expect(
        (yield* stack.plan(lowerMinimum)).resources.StandaloneInstance,
      ).toMatchObject({
        action: "update",
      });
      const repaired = yield* stack.deploy(lowerMinimum);
      expect(repaired.dbInstanceArn).toBe(created.dbInstanceArn);
      expect(repaired.allocatedStorage).toBe(50);
      expect([0, 50]).toContain(repaired.maxAllocatedStorage ?? 0);
      const settled = (yield* describe).DBInstances?.[0];
      expect([0, 50]).toContain(settled?.MaxAllocatedStorage ?? 0);
      expect(settled?.AllocatedStorage).toBe(50);
      expect(
        (yield* stack.plan(lowerMinimum)).resources.StandaloneInstance,
      ).toMatchObject({ action: "noop" });

      const disabled = program(20, 0);
      const explicitZero = yield* stack.deploy(disabled);
      expect([0, 50]).toContain(explicitZero.maxAllocatedStorage ?? 0);
      expect(explicitZero.allocatedStorage).toBe(50);
      expect(
        (yield* stack.plan(disabled)).resources.StandaloneInstance,
      ).toMatchObject({ action: "noop" });

      yield* stack.destroy();
      const gone = yield* describe.pipe(
        Effect.as(false),
        Effect.catchTag("DBInstanceNotFoundFault", () => Effect.succeed(true)),
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          times: 8,
          until: (absent) => absent,
        }),
      );
      expect(gone).toBe(true);
    }),
);

// Fingerprint-guarded master password lifecycle (#876), gated behind
// RDS_TEST_LIFECYCLE=1 (real db.t3.micro, ~15-25 min).
//
// AWS never returns the master password, so the provider fingerprints the
// configured value (identifier-salted sha256, persisted `Redacted`) and only
// sends `MasterUserPassword` on modify when the fingerprint changed. RDS
// durably records a "Reset master credentials" event whenever a password
// modify actually applies, which makes the guard observable out-of-band:
//
//   1. create with password P1 — set at create time, no reset event
//   2. redeploy P1 with a tag change (forces reconcile) — fingerprint stable
//   3. redeploy P2 — fingerprint changes; RDS records the credentials reset
//
// After step 3's event is observed, the reset-event count over the whole run
// must be exactly 1 — the anchored positive event proves step 2's reconcile
// did not re-send the unchanged password (pre-#876 every reconcile did,
// putting the instance through a live `resetting-master-credentials` cycle).
test.provider.skipIf(!process.env.RDS_TEST_LIFECYCLE)(
  "master password: fingerprint guard skips unchanged, applies rotation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const identifier = "alchemy-rds-fingerprint";

      // The testing account has no default VPC/subnets — provision a network
      // and DB subnet group like the standalone lifecycle test above.
      const network = Effect.gen(function* () {
        const net = yield* Network("FingerprintNet", {
          cidrBlock: "10.42.0.0/16",
        });
        const subnetGroup = yield* DBSubnetGroup("FingerprintSubnetGroup", {
          description: "alchemy master-password fingerprint lifecycle",
          subnetIds: net.privateSubnetIds,
        });
        return { dbSubnetGroupName: subnetGroup.dbSubnetGroupName };
      });

      const deployInstance = (password: string, round: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const { dbSubnetGroupName } = yield* network;
            return yield* DBInstance("FingerprintInstance", {
              dbInstanceIdentifier: identifier,
              engine: "postgres",
              dbInstanceClass: "db.t3.micro",
              allocatedStorage: 20,
              masterUsername: "alchemy",
              masterUserPassword: Redacted.make(password),
              deletionProtection: false,
              dbSubnetGroupName,
              publiclyAccessible: false,
              // A changed tag guarantees the engine sees a props diff and
              // runs `reconcile` — the exact path that used to re-send the
              // unchanged password.
              tags: { round },
            });
          }),
        );

      const resetEvents = rds
        .describeEvents({
          SourceIdentifier: identifier,
          SourceType: "db-instance",
          // Minutes of lookback — generously covers the whole test run.
          Duration: 180,
        })
        .pipe(
          Effect.map((response) =>
            (response.Events ?? []).filter((event) =>
              /reset master credentials/i.test(event.Message ?? ""),
            ),
          ),
        );

      const created = yield* deployInstance("FingerprintPass1", "one");
      const createdFingerprint = created.masterUserPasswordFingerprint;
      expect(createdFingerprint).toBeDefined();
      // sha256 hex digest — never the password itself.
      expect(Redacted.value(createdFingerprint!)).toMatch(/^[0-9a-f]{64}$/);

      // Same password, tag-only change → reconcile runs but must skip the
      // `MasterUserPassword` modify (same fingerprint).
      const unchanged = yield* deployInstance("FingerprintPass1", "two");
      expect(unchanged.dbInstanceArn).toBe(created.dbInstanceArn);
      expect(Redacted.value(unchanged.masterUserPasswordFingerprint!)).toBe(
        Redacted.value(createdFingerprint!),
      );

      // Rotation: new password → new fingerprint, and RDS applies a real
      // master-credentials reset.
      const rotated = yield* deployInstance("FingerprintPass2", "three");
      expect(rotated.dbInstanceArn).toBe(created.dbInstanceArn);
      expect(Redacted.value(rotated.masterUserPasswordFingerprint!)).not.toBe(
        Redacted.value(createdFingerprint!),
      );

      // The reset event lands when the modify applies; poll bounded for it,
      // then assert the count over the whole run is exactly 1 — proving
      // round "two" (unchanged password) never triggered a reset.
      const events = yield* resetEvents.pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (found) => found.length > 0,
          times: 8,
        }),
      );
      expect(events).toHaveLength(1);

      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);
