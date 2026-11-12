import * as ClickHouseCloud from "@alchemy.run/clickhouse-cloud";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as stack from "@distilled.cloud/clickhouse-cloud/click_stack";
import * as Effect from "effect/Effect";
import { cleanSlate } from "../fixtures/cleanup.ts";
import { needsService, testServiceId } from "../fixtures/service.ts";

const { test } = Test.make({ providers: ClickHouseCloud.providers() });

// ClickStack is set up per service in the console (no API), and a source
// names a ClickStack connection the API can't list. Set
// CLICKHOUSE_CLOUD_TEST_CLICKSTACK_CONNECTION to a connection ID of a
// service with ClickStack set up (and CLICKHOUSE_CLOUD_TEST_SERVICE_ID to it).
const connection = process.env.CLICKHOUSE_CLOUD_TEST_CLICKSTACK_CONNECTION;

const declare = (name: string, conn: string) =>
  Effect.gen(function* () {
    const serviceId = yield* testServiceId;
    return yield* ClickHouseCloud.ClickStack.Source("Logs", {
      serviceId,
      source: {
        kind: "log",
        name,
        connection: conn,
        from: { databaseName: "system", tableName: "text_log" },
        timestampValueExpression: "event_time",
        defaultTableSelectExpression: "event_time, level, message",
        severityTextExpression: "level",
        bodyExpression: "message",
      },
    });
  });

test.provider.skipIf(needsService || connection !== undefined)(
  "a service without ClickStack set up fails with the API's Forbidden",
  (scratch) =>
    Effect.gen(function* () {
      yield* cleanSlate(scratch);
      const error = yield* scratch.deploy(declare("logs", "unknown")).pipe(Effect.flip);
      expect(error._tag).toEqual("Forbidden");
      expect(error.message).toEqual("FORBIDDEN: ClickStack has not been setup for this service");
      yield* scratch.destroy();
    }).pipe(Effect.scoped),
  { tags: ["provider:clickhouse-cloud", "live"], timeout: 120_000 },
);

test.provider.skipIf(needsService || connection === undefined)(
  "create a log source, rename it in place, delete it",
  (scratch) =>
    Effect.gen(function* () {
      yield* cleanSlate(scratch);
      const organizationId = yield* ClickHouseCloud.organizationId;
      const first = yield* scratch.deploy(declare("logs", connection!));
      const second = yield* scratch.deploy(declare("server logs", connection!));
      expect(second.id).toEqual(first.id);
      const observed = yield* stack.getClickStackSource({
        organizationId,
        serviceId: first.serviceId,
        clickStackSourceId: first.id,
      });
      expect(observed.result?.name).toEqual("server logs");
      yield* scratch.destroy();
      const gone = yield* stack
        .getClickStackSource({
          organizationId,
          serviceId: first.serviceId,
          clickStackSourceId: first.id,
        })
        .pipe(Effect.flip);
      expect(gone._tag).toEqual("NotFound");
    }).pipe(Effect.scoped),
  { tags: ["provider:clickhouse-cloud", "live"], timeout: 900_000 },
);
