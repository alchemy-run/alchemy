import * as ClickHouseCloud from "@alchemy.run/clickhouse-cloud";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as backup from "@distilled.cloud/clickhouse-cloud/backup";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: ClickHouseCloud.providers() });

// Needs a running service: minutes to create and billed compute. Set
// CLICKHOUSE_CLOUD_TEST_SLOW=1 to run it.
const slow = !process.env.CLICKHOUSE_CLOUD_TEST_SLOW;

const getConfiguration = (serviceId: string) =>
  Effect.gen(function* () {
    const organizationId = yield* ClickHouseCloud.organizationId;
    const { result } = yield* backup.getBackupConfiguration({ organizationId, serviceId });
    return result!;
  });

const stackWith = (config: {
  backupPeriodInHours?: number;
  backupRetentionPeriodInHours?: number;
}) =>
  Effect.gen(function* () {
    const svc = yield* ClickHouseCloud.Service.Service("BackedUp", {
      provider: "aws",
      region: "us-east-1",
      ipAccessList: [{ source: "0.0.0.0/0" }],
      minReplicaMemoryGb: 8,
      maxReplicaMemoryGb: 8,
      numReplicas: 1,
      idleScaling: true,
      idleTimeoutMinutes: 5,
    });
    const backups = yield* ClickHouseCloud.Backup.BackupConfiguration("Backups", {
      serviceId: svc.serviceId,
      ...config,
    });
    return { svc, backups };
  });

test.provider.skipIf(slow)(
  "configure backups, change them, reset them on destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // The service alone first, to record its defaults.
      const bare = yield* stack.deploy(
        ClickHouseCloud.Service.Service("BackedUp", {
          provider: "aws",
          region: "us-east-1",
          ipAccessList: [{ source: "0.0.0.0/0" }],
          minReplicaMemoryGb: 8,
          maxReplicaMemoryGb: 8,
          numReplicas: 1,
          idleScaling: true,
          idleTimeoutMinutes: 5,
        }),
      );
      const defaults = yield* getConfiguration(bare.serviceId);

      const first = yield* stack.deploy(
        stackWith({ backupPeriodInHours: 12, backupRetentionPeriodInHours: 48 }),
      );
      expect(first.backups.backupPeriodInHours).toEqual(12);
      expect(first.backups.backupRetentionPeriodInHours).toEqual(48);
      expect(yield* getConfiguration(bare.serviceId)).toMatchObject({
        backupPeriodInHours: 12,
        backupRetentionPeriodInHours: 48,
      });

      const second = yield* stack.deploy(stackWith({ backupRetentionPeriodInHours: 72 }));
      expect(second.backups.backupRetentionPeriodInHours).toEqual(72);
      expect((yield* getConfiguration(bare.serviceId)).backupRetentionPeriodInHours).toEqual(72);

      // Removing the configuration resets what it managed; the service stays.
      yield* stack.deploy(
        ClickHouseCloud.Service.Service("BackedUp", {
          provider: "aws",
          region: "us-east-1",
          ipAccessList: [{ source: "0.0.0.0/0" }],
          minReplicaMemoryGb: 8,
          maxReplicaMemoryGb: 8,
          numReplicas: 1,
          idleScaling: true,
          idleTimeoutMinutes: 5,
        }),
      );
      expect((yield* getConfiguration(bare.serviceId)).backupRetentionPeriodInHours).toEqual(
        defaults.backupRetentionPeriodInHours,
      );

      yield* stack.destroy();
    }),
  { tags: ["provider:clickhouse-cloud", "live"], timeout: 3_600_000 },
);
