import * as ClickHouseCloud from "@alchemy.run/clickhouse-cloud";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as saved from "@distilled.cloud/clickhouse-cloud/saved_queries";
import * as Effect from "effect/Effect";
import { cleanSlate } from "../fixtures/cleanup.ts";
import { needsService, testServiceId } from "../fixtures/service.ts";

const { test } = Test.make({ providers: ClickHouseCloud.providers() });

const getQuery = (serviceId: string, queryId: string) =>
  Effect.gen(function* () {
    const organizationId = yield* ClickHouseCloud.organizationId;
    return yield* saved.getSavedQuery({ organizationId, serviceId, queryId }).pipe(
      Effect.map(({ result }) => result),
      Effect.catchTag("NotFound", () => Effect.undefined),
    );
  });

const declare = (props: { name?: string; sql: string; parameters?: Record<string, string> }) =>
  Effect.gen(function* () {
    const serviceId = yield* testServiceId;
    return yield* ClickHouseCloud.SavedQueries.SavedQuery("TopNumbers", {
      serviceId,
      database: "default",
      ...props,
    });
  });

test.provider.skipIf(needsService)(
  "save a query, change its SQL and parameters in place, rename it, delete it",
  (stack) =>
    Effect.gen(function* () {
      yield* cleanSlate(stack);

      const created = yield* stack.deploy(
        declare({
          sql: "SELECT number FROM system.numbers LIMIT {n:UInt8}",
          parameters: { n: "3" },
        }),
      );
      const observed = yield* getQuery(created.serviceId, created.queryId);
      expect(observed?.sql).toEqual("SELECT number FROM system.numbers LIMIT {n:UInt8}");
      expect(observed?.parameters).toEqual({ n: "3" });
      expect(observed?.name).toEqual(created.name);

      const updated = yield* stack.deploy(
        declare({
          name: "Top numbers",
          sql: "SELECT number * 2 AS doubled FROM system.numbers LIMIT {n:UInt8}",
          parameters: { n: "5" },
        }),
      );
      expect(updated.queryId).toEqual(created.queryId);
      const afterUpdate = yield* getQuery(created.serviceId, created.queryId);
      expect(afterUpdate?.name).toEqual("Top numbers");
      expect(afterUpdate?.sql).toEqual(
        "SELECT number * 2 AS doubled FROM system.numbers LIMIT {n:UInt8}",
      );
      expect(afterUpdate?.parameters).toEqual({ n: "5" });

      yield* stack.destroy();
      expect(yield* getQuery(created.serviceId, created.queryId)).toBeUndefined();
    }).pipe(Effect.scoped),
  { tags: ["provider:clickhouse-cloud", "live"], timeout: 900_000 },
);
