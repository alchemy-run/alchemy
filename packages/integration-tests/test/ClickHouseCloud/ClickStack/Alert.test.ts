import * as ClickHouseCloud from "@alchemy.run/clickhouse-cloud";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { cleanSlate } from "../fixtures/cleanup.ts";
import { needsService, testServiceId } from "../fixtures/service.ts";

const { test } = Test.make({ providers: ClickHouseCloud.providers() });

// ClickStack is set up per service in the console (no API). The lifecycle
// runs in Source.test.ts's setup (CLICKHOUSE_CLOUD_TEST_CLICKSTACK_CONNECTION);
// without ClickStack, the API refuses every ClickStack call.
const clickstack = process.env.CLICKHOUSE_CLOUD_TEST_CLICKSTACK_CONNECTION !== undefined;

test.provider.skipIf(needsService || clickstack)(
  "a service without ClickStack set up fails with FeatureUnavailable",
  (scratch) =>
    Effect.gen(function* () {
      yield* cleanSlate(scratch);
      const error = yield* scratch
        .deploy(
          Effect.gen(function* () {
            const serviceId = yield* testServiceId;
            return yield* ClickHouseCloud.ClickStack.Alert("Probe", {
              serviceId,
              name: "errors",
              source: "saved_search",
              savedSearchId: "<saved search id>",
              interval: "5m",
              threshold: 1,
              thresholdType: "above",
              channels: [],
            });
          }),
        )
        .pipe(Effect.flip);
      expect(error._tag).toEqual("FeatureUnavailable");
      expect(error.message).toEqual("FORBIDDEN: ClickStack has not been setup for this service");
      yield* scratch.destroy();
    }).pipe(Effect.scoped),
  { tags: ["provider:clickhouse-cloud", "live"], timeout: 120_000 },
);
