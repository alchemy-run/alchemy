import * as ClickHouseCloud from "@alchemy.run/clickhouse-cloud";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as service from "@distilled.cloud/clickhouse-cloud/service";
import * as Effect from "effect/Effect";
import { cleanSlate } from "../fixtures/cleanup.ts";
import { needsService, testServiceId } from "../fixtures/service.ts";

const { test } = Test.make({ providers: ClickHouseCloud.providers() });

const getSchedule = (serviceId: string) =>
  Effect.gen(function* () {
    const organizationId = yield* ClickHouseCloud.organizationId;
    return yield* service.getScalingSchedule({ organizationId, serviceId }).pipe(
      Effect.map(({ result }) => result),
      Effect.catchTag("NotFound", () => Effect.undefined),
    );
  });

// A window at 01:00-02:00 UTC on Mondays: scaling the same as the base
// config, so the schedule never changes what the service runs with.
const declare = (weekdays: number[]) =>
  Effect.gen(function* () {
    const serviceId = yield* testServiceId;
    return yield* ClickHouseCloud.Service.ScalingSchedule("Schedule", {
      serviceId,
      entries: [
        {
          name: "night",
          weekdays,
          startHourUtc: 1,
          endHourUtc: 2,
          minReplicaMemoryGb: 8,
          maxReplicaMemoryGb: 8,
        },
      ],
    });
  });

test.provider.skipIf(needsService)(
  "set a scaling schedule, replace its windows in place, delete it",
  (stack) =>
    Effect.gen(function* () {
      yield* cleanSlate(stack);

      const first = yield* stack.deploy(declare([1]));
      expect(first.entries.map((e) => [e.name, e.weekdays])).toEqual([["night", [1]]]);
      expect((yield* getSchedule(first.serviceId))?.entries.map((e) => e.weekdays)).toEqual([[1]]);

      const unchanged = yield* stack.deploy(declare([1]));
      expect(unchanged.entries[0]?.id).toEqual(first.entries[0]?.id);

      yield* stack.deploy(declare([1, 3]));
      expect((yield* getSchedule(first.serviceId))?.entries[0]?.weekdays).toEqual([1, 3]);

      yield* stack.destroy();
      expect(yield* getSchedule(first.serviceId)).toBeUndefined();
    }).pipe(Effect.scoped),
  { tags: ["provider:clickhouse-cloud", "live"], timeout: 900_000 },
);

test.provider.skipIf(needsService)(
  "refuse an empty schedule with a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* cleanSlate(stack);
      const error = yield* stack
        .deploy(
          Effect.gen(function* () {
            const serviceId = yield* testServiceId;
            return yield* ClickHouseCloud.Service.ScalingSchedule("Empty", {
              serviceId,
              entries: [],
            });
          }),
        )
        .pipe(Effect.flip);
      expect(error._tag).toEqual("ClickHouseCloud.FeatureUnavailable");
      yield* stack.destroy();
    }).pipe(Effect.scoped),
  { tags: ["provider:clickhouse-cloud", "live"], timeout: 120_000 },
);
