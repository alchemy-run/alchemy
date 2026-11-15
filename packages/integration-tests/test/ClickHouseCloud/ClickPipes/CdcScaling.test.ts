import * as ClickHouseCloud from "@alchemy.run/clickhouse-cloud";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { cleanSlate } from "../fixtures/cleanup.ts";
import { needsService, testServiceId } from "../fixtures/service.ts";

const { test } = Test.make({ providers: ClickHouseCloud.providers() });

const declare = Effect.gen(function* () {
  const serviceId = yield* testServiceId;
  return yield* ClickHouseCloud.ClickPipes.CdcScaling("CdcSize", {
    serviceId,
    replicaCpuMillicores: 2000,
    replicaMemoryGb: 8,
  });
});

// The CDC infrastructure exists only once a database ClickPipe was created;
// that needs a reachable Postgres, MySQL or MongoDB with replication on, and
// bills CDC compute.
test.provider.skipIf(needsService)(
  "a service without a database ClickPipe fails with FeatureUnavailable",
  (stack) =>
    Effect.gen(function* () {
      yield* cleanSlate(stack);
      const error = yield* stack.deploy(declare).pipe(Effect.flip);
      expect(error._tag).toEqual("ClickHouseCloud.FeatureUnavailable");
      yield* stack.destroy();
    }).pipe(Effect.scoped),
  { tags: ["provider:clickhouse-cloud", "live"], timeout: 120_000 },
);
