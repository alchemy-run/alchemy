import * as ClickHouseCloud from "@alchemy.run/clickhouse-cloud";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as snapshot from "@distilled.cloud/clickhouse-cloud/snapshot";
import * as Effect from "effect/Effect";
import { cleanSlate } from "../fixtures/cleanup.ts";
import { needsService, testServiceId } from "../fixtures/service.ts";

const { test } = Test.make({ providers: ClickHouseCloud.providers() });

// Snapshots are an early-access API (`Organization.snapshots`). Set
// CLICKHOUSE_CLOUD_TEST_SNAPSHOTS=1 on an organization that has it.
const snapshots = !!process.env.CLICKHOUSE_CLOUD_TEST_SNAPSHOTS;

const declare = (gap: 30 | 60) =>
  Effect.gen(function* () {
    const serviceId = yield* testServiceId;
    return yield* ClickHouseCloud.Snapshot.SnapshotConfiguration("Snapshots", {
      serviceId,
      gap,
      timeFrame: 1440,
    });
  });

test.provider.skipIf(needsService || snapshots)(
  "without snapshot access the deploy fails with FeatureUnavailable",
  (stack) =>
    Effect.gen(function* () {
      yield* cleanSlate(stack);
      const error = yield* stack.deploy(declare(60)).pipe(Effect.flip);
      expect(error._tag).toEqual("FeatureUnavailable");
      expect(error.message).toEqual("FORBIDDEN: early access API endpoint");
      yield* stack.destroy();
    }).pipe(Effect.scoped),
  { tags: ["provider:clickhouse-cloud", "live"], timeout: 120_000 },
);

test.provider.skipIf(needsService || !snapshots)(
  "schedule snapshots, change the gap in place, switch them off on destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* cleanSlate(stack);
      const organizationId = yield* ClickHouseCloud.organizationId;
      const first = yield* stack.deploy(declare(60));
      expect(first.enabled).toBe(true);
      yield* stack.deploy(declare(30));
      const observed = yield* snapshot.getSnapshotConfiguration({
        organizationId,
        serviceId: first.serviceId,
      });
      expect(observed.gap).toEqual(30);
      yield* stack.destroy();
      const after = yield* snapshot.getSnapshotConfiguration({
        organizationId,
        serviceId: first.serviceId,
      });
      expect(after.enabled).toBe(false);
    }).pipe(Effect.scoped),
  { tags: ["provider:clickhouse-cloud", "live"], timeout: 900_000 },
);
