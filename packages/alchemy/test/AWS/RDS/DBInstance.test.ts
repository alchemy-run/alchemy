import * as AWS from "@/AWS";
import { Network } from "@/AWS/EC2/Network";
import { DBCluster, DBInstance } from "@/AWS/RDS";
import type { DBInstanceProps } from "@/AWS/RDS/DBInstance.ts";
import { DBSubnetGroup } from "@/AWS/RDS/DBSubnetGroup.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as rds from "@distilled.cloud/aws/rds";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";

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
// (rejected as > the 35-day maximum). The in-range round-trip (create "1 day"
// → read 1 → modify "3 days" → read 3) is covered by the
// RDS_TEST_LIFECYCLE-gated lifecycle test below.
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
  { timeout: 1_800_000 },
);

// RDS provisioning and port changes exceed the default live-test budget.
test.provider.skipIf(!process.env.RDS_TEST_LIFECYCLE)(
  "standalone instance: endpoint port changes once, unchanged ports do not modify (PR 1595)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const network = Effect.gen(function* () {
        const net = yield* Network("RdsNet", { cidrBlock: "10.41.0.0/16" });
        const subnetGroup = yield* DBSubnetGroup("RdsSubnetGroup", {
          description: "alchemy standalone instance lifecycle",
          subnetIds: net.privateSubnetIds,
        });
        return { dbSubnetGroupName: subnetGroup.dbSubnetGroupName };
      });
      const program = (port: number, round: string, grown = false) =>
        Effect.gen(function* () {
          const { dbSubnetGroupName } = yield* network;
          return yield* DBInstance("StandaloneInstance", {
            engine: "postgres",
            dbInstanceClass: "db.t3.micro",
            allocatedStorage: grown ? 25 : 20,
            storageType: "gp3",
            masterUsername: "alchemy",
            manageMasterUserPassword: true,
            backupRetentionPeriod: grown ? "3 days" : "1 day",
            enablePerformanceInsights: grown ? true : undefined,
            deletionProtection: false,
            dbSubnetGroupName,
            publiclyAccessible: false,
            port,
            tags: { round },
          });
        });

      // A redundant port modify need not change the endpoint or emit an event.
      // Observe real requests without changing transport, credentials or responses.
      const client = yield* HttpClient.HttpClient;
      const requests: URLSearchParams[] = [];
      const observedClient = client.pipe(
        HttpClient.tapRequest((request) =>
          Effect.sync(() => {
            if (request.body._tag !== "Uint8Array") return;
            const parameters = new URLSearchParams(
              new TextDecoder().decode(request.body.body),
            );
            if (
              ["DescribeDBInstances", "ModifyDBInstance"].includes(
                parameters.get("Action") ?? "",
              )
            ) {
              requests.push(parameters);
            }
          }),
        ),
      );
      const modifies = () =>
        requests.filter(
          (request) => request.get("Action") === "ModifyDBInstance",
        );
      const deploy = (port: number, round: string, grown = false) =>
        stack
          .deploy(program(port, round, grown))
          .pipe(Effect.provideService(HttpClient.HttpClient, observedClient));

      const created = yield* deploy(5432, "created");
      expect(created.allocatedStorage).toBe(20);
      expect(created.storageType).toBe("gp3");
      expect(created.backupRetentionPeriod).toBe(1);
      const describe = rds.describeDBInstances({
        DBInstanceIdentifier: created.dbInstanceIdentifier,
      });
      const initial = (yield* describe).DBInstances?.[0];
      expect(initial?.Endpoint?.Port).toBe(5432);
      // This is the AWS observation that the old comparison misinterpreted.
      expect(initial?.DbInstancePort).toBe(0);

      const samePort = program(5432, "same-port");
      expect(
        (yield* stack.plan(samePort)).resources.StandaloneInstance,
      ).toMatchObject({ action: "update" });
      requests.length = 0;
      yield* deploy(5432, "same-port");
      expect(
        requests.some(
          (request) => request.get("Action") === "DescribeDBInstances",
        ),
      ).toBe(true);
      expect(modifies()).toHaveLength(0);
      const unchanged = (yield* describe).DBInstances?.[0];
      expect(unchanged?.Endpoint?.Port).toBe(5432);
      expect(unchanged?.PendingModifiedValues?.Port).toBeUndefined();
      expect(unchanged?.TagList).toContainEqual({
        Key: "round",
        Value: "same-port",
      });

      expect(
        (yield* stack.plan(program(5433, "changed", true))).resources
          .StandaloneInstance,
      ).toMatchObject({ action: "update" });
      requests.length = 0;
      const updated = yield* deploy(5433, "changed", true);
      expect(modifies()).toHaveLength(1);
      expect(modifies()[0]!.get("DBPortNumber")).toBe("5433");
      expect(updated.dbInstanceArn).toBe(created.dbInstanceArn);
      expect(updated.endpointPort).toBe(5433);
      const changed = (yield* describe).DBInstances?.[0];
      expect(changed?.Endpoint?.Port).toBe(5433);
      expect(changed?.AllocatedStorage).toBe(25);
      expect(changed?.BackupRetentionPeriod).toBe(3);
      expect(changed?.PendingModifiedValues?.Port).toBeUndefined();

      requests.length = 0;
      yield* deploy(5433, "changed-again", true);
      expect(
        requests.some(
          (request) => request.get("Action") === "DescribeDBInstances",
        ),
      ).toBe(true);
      expect(modifies()).toHaveLength(0);
      const settled = (yield* describe).DBInstances?.[0];
      expect(settled?.Endpoint?.Port).toBe(5433);
      expect(settled?.PendingModifiedValues?.Port).toBeUndefined();
      expect(settled?.TagList).toContainEqual({
        Key: "round",
        Value: "changed-again",
      });
      expect(
        (yield* stack.plan(program(5433, "changed-again", true))).resources
          .StandaloneInstance,
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
  { timeout: 2_400_000 },
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
          times: 36,
        }),
      );
      expect(events).toHaveLength(1);

      yield* stack.destroy();
    }),
  { timeout: 2_400_000 },
);
