import * as Neon from "@alchemy.run/neon";
import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as galaxy from "@distilled.cloud/starburst-galaxy";
import type { InputProps } from "alchemy/Input";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { evaluateNow, QualityWarehouse } from "../fixtures/quality.ts";
import { SALES } from "../fixtures/warehouse.ts";
import { expectGone, freshStack } from "../helpers.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(StarburstGalaxy.providers(), Neon.providers()),
});

const checkExists = (dataQualityCheckId: string) =>
  galaxy.dataQuality.getDataQualityCheck({ dataQualityCheckId }).pipe(
    Effect.as(true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );

type Props = InputProps<StarburstGalaxy.DataQuality.DataQualityCheckProps>;
type CheckProps = Pick<Props, "query"> & Partial<Props>;

test.provider(
  "check a table with SQL, evaluate it, change it; an expression without statistics is refused",
  (stack) =>
    Effect.gen(function* () {
      yield* freshStack(stack);

      const app = (check?: (orders: Output.Output<string>) => CheckProps) =>
        Effect.gen(function* () {
          const fixture = yield* QualityWarehouse;
          const quality =
            check === undefined
              ? undefined
              : yield* StarburstGalaxy.DataQuality.DataQualityCheck("OrdersValid", {
                  // Through the schedule: a SQL check runs as the schedule's role.
                  catalogId: fixture.schedule.catalogId,
                  ...SALES,
                  kind: "SqlQuery" as const,
                  clusterId: fixture.cluster.clusterId,
                  severity: "High" as const,
                  ...check(
                    Output.interpolate`${fixture.catalog.name}.${SALES.schemaName}.${SALES.tableName}`,
                  ),
                });
          return { ...fixture, quality };
        });

      const created = yield* stack.deploy(
        app((orders) => ({
          query: Output.interpolate`SELECT count(*) > 0 FROM ${orders}`,
          category: "Completeness",
        })),
      );
      const checkId = created.quality!.dataQualityCheckId;
      const live = yield* galaxy.dataQuality.getDataQualityCheck({ dataQualityCheckId: checkId });
      expect(live.kind).toBe("SqlQuery");
      expect(live.category).toBe("Completeness");
      expect(live.tableId).toBe(SALES.tableName);

      // The schedule's role runs it on the free cluster: the table has orders.
      const evaluated = yield* evaluateNow(checkId, created.cluster.clusterId);
      expect(evaluated.latestEvaluation?.status).toBe("Success");

      // The query, severity and description converge in place.
      const changed = yield* stack.deploy(
        app((orders) => ({
          query: Output.interpolate`SELECT count(*) = 0 FROM ${orders} WHERE amount < 0`,
          severity: "Critical",
          description: "no order has a negative amount",
        })),
      );
      expect(changed.quality?.dataQualityCheckId).toBe(checkId);
      const changedLive = yield* galaxy.dataQuality.getDataQualityCheck({
        dataQualityCheckId: checkId,
      });
      expect(changedLive.query).toContain("amount < 0");
      expect(changedLive.severity).toBe("Critical");
      expect(changedLive.description).toBe("no order has a negative amount");

      // An expression check reads table statistics, which the PostgreSQL
      // connector can't collect (it refuses ANALYZE): Galaxy refuses the
      // check, and the SQL check stays.
      const refused = yield* stack
        .deploy(
          app(() => ({
            kind: "QualityExpression",
            query: "row_count_min(1)",
            clusterId: undefined,
          })),
        )
        .pipe(Effect.flip);
      expect(refused.message).toContain("Stats are not available for table");
      expect(yield* checkExists(checkId)).toBe(true);

      yield* stack.destroy();
      yield* expectGone(checkExists(checkId));
    }).pipe(Effect.scoped),
  {
    tags: [
      "provider:starburst-galaxy",
      "provider:starburst-galaxy:data-quality",
      "provider:neon",
      "live",
    ],
    timeout: 1_200_000,
  },
);
