import * as ClickHouseCloud from "@alchemy.run/clickhouse-cloud";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { cleanSlate } from "../fixtures/cleanup.ts";
import { needsService, testServiceId } from "../fixtures/service.ts";

const { test } = Test.make({ providers: ClickHouseCloud.providers() });

// Workload identity for ClickPipes is a private preview. Set
// CLICKHOUSE_CLOUD_TEST_WORKLOAD_IDENTITY=1 once ClickHouse enabled it.
const enabled = !!process.env.CLICKHOUSE_CLOUD_TEST_WORKLOAD_IDENTITY;

const declare = Effect.gen(function* () {
  const serviceId = yield* testServiceId;
  return yield* ClickHouseCloud.ClickPipes.WorkloadIdentity("Identity", { serviceId });
});

test.provider.skipIf(needsService || enabled)(
  "without the preview the deploy fails with FeatureUnavailable",
  (stack) =>
    Effect.gen(function* () {
      yield* cleanSlate(stack);
      const error = yield* stack.deploy(declare).pipe(Effect.flip);
      expect(error._tag).toEqual("ClickHouseCloud.FeatureUnavailable");
      yield* stack.destroy();
    }).pipe(Effect.scoped),
  { tags: ["provider:clickhouse-cloud", "live"], timeout: 120_000 },
);

test.provider.skipIf(needsService || !enabled)(
  "read the GCP principal ClickPipes authenticate as",
  (stack) =>
    Effect.gen(function* () {
      yield* cleanSlate(stack);
      const identity = yield* stack.deploy(declare);
      expect(identity.principal).toMatch(/@.*\.iam\.gserviceaccount\.com$/);
      yield* stack.destroy();
    }).pipe(Effect.scoped),
  { tags: ["provider:clickhouse-cloud", "live"], timeout: 900_000 },
);
