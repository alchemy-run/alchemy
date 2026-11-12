import * as ClickHouseCloud from "@alchemy.run/clickhouse-cloud";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as service from "@distilled.cloud/clickhouse-cloud/service";
import * as Effect from "effect/Effect";
import { cleanSlate } from "../fixtures/cleanup.ts";
import { needsService, testServiceId } from "../fixtures/service.ts";

const { test } = Test.make({ providers: ClickHouseCloud.providers() });

// The settings API is enabled per organization by ClickHouse support. Set
// CLICKHOUSE_CLOUD_TEST_SETTINGS_API=1 once it is.
const settingsApi = !!process.env.CLICKHOUSE_CLOUD_TEST_SETTINGS_API;

const declare = (value: number) =>
  Effect.gen(function* () {
    const serviceId = yield* testServiceId;
    return yield* ClickHouseCloud.Service.ClickHouseSetting("MaxThreads", {
      serviceId,
      name: "max_threads",
      value,
    });
  });

test.provider.skipIf(needsService || settingsApi)(
  "without the settings API the deploy fails with the API's Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* cleanSlate(stack);
      const error = yield* stack.deploy(declare(4)).pipe(Effect.flip);
      expect(error._tag).toEqual("Forbidden");
      expect(error.message).toEqual(
        "FORBIDDEN: ClickHouse settings API is not enabled for this organization. Please contact support to enable this feature",
      );
      yield* stack.destroy();
    }).pipe(Effect.scoped),
  { tags: ["provider:clickhouse-cloud", "live"], timeout: 120_000 },
);

test.provider.skipIf(needsService || !settingsApi)(
  "set a setting, change its value in place, reset it on destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* cleanSlate(stack);
      const organizationId = yield* ClickHouseCloud.organizationId;
      const listed = (serviceId: string) =>
        service
          .listServiceClickHouseSettings({ organizationId, serviceId })
          .pipe(Effect.map(({ result }) => result?.settings ?? []));

      const first = yield* stack.deploy(declare(4));
      expect(first.value).toEqual(4);
      const second = yield* stack.deploy(declare(8));
      expect(
        (yield* listed(second.serviceId)).find((s) => s.name === "max_threads")?.value,
      ).toEqual(8);

      yield* stack.destroy();
      expect(
        (yield* listed(second.serviceId)).find((s) => s.name === "max_threads"),
      ).toBeUndefined();
    }).pipe(Effect.scoped),
  { tags: ["provider:clickhouse-cloud", "live"], timeout: 1_800_000 },
);
