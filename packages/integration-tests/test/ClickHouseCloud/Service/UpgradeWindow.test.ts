import * as ClickHouseCloud from "@alchemy.run/clickhouse-cloud";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as service from "@distilled.cloud/clickhouse-cloud/service";
import * as Effect from "effect/Effect";
import { cleanSlate } from "../fixtures/cleanup.ts";
import { needsService, testServiceId } from "../fixtures/service.ts";

const { test } = Test.make({ providers: ClickHouseCloud.providers() });

// Scheduled upgrades need the Enterprise tier. Set CLICKHOUSE_CLOUD_TEST_ENTERPRISE=1
// on an Enterprise organization.
const enterprise = !!process.env.CLICKHOUSE_CLOUD_TEST_ENTERPRISE;

const declare = (weekday: number) =>
  Effect.gen(function* () {
    const serviceId = yield* testServiceId;
    return yield* ClickHouseCloud.Service.UpgradeWindow("Upgrades", {
      serviceId,
      weekday,
      startHourUtc: 6,
    });
  });

test.provider.skipIf(needsService || enterprise)(
  "below Enterprise the deploy fails with FeatureUnavailable",
  (stack) =>
    Effect.gen(function* () {
      yield* cleanSlate(stack);
      const error = yield* stack.deploy(declare(2)).pipe(Effect.flip);
      expect(error._tag).toEqual("FeatureUnavailable");
      expect(error.message).toEqual(
        "FORBIDDEN: Cannot use scheduled upgrades in SCALE pricing package",
      );
      yield* stack.destroy();
    }).pipe(Effect.scoped),
  { tags: ["provider:clickhouse-cloud", "live"], timeout: 120_000 },
);

test.provider.skipIf(needsService || !enterprise)(
  "set an upgrade window, move it in place, remove it",
  (stack) =>
    Effect.gen(function* () {
      yield* cleanSlate(stack);
      const organizationId = yield* ClickHouseCloud.organizationId;
      const first = yield* stack.deploy(declare(2));
      expect(first.duration).toEqual(6);
      yield* stack.deploy(declare(4));
      const observed = yield* service.getUpgradeWindow({
        organizationId,
        serviceId: first.serviceId,
      });
      expect(observed.result?.weekday).toEqual(4);
      yield* stack.destroy();
      const gone = yield* service
        .getUpgradeWindow({ organizationId, serviceId: first.serviceId })
        .pipe(Effect.flip);
      expect(gone._tag).toEqual("NotFound");
    }).pipe(Effect.scoped),
  { tags: ["provider:clickhouse-cloud", "live"], timeout: 900_000 },
);
