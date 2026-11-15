import * as Cloudflare from "@alchemy.run/cloudflare";
import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { OrdersCheck, WAREHOUSES, warehouseLookup } from "./bindings.ts";

const BindingsWarehouse = warehouseLookup(WAREHOUSES.quality);

const { DataQuality } = StarburstGalaxy;

/** A Worker that evaluates the orders check and reads every data quality metric. */
export default class GalaxyQualityWorker extends Cloudflare.Worker<GalaxyQualityWorker>()(
  "GalaxyQualityWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const check = yield* OrdersCheck;
    const evaluate = yield* DataQuality.EvaluateDataQualityCheck(check);
    const latest = yield* DataQuality.GetLatestDataQualityCheckEvaluation(check);
    const evaluations = yield* DataQuality.GetDataQualityCheckEvaluations(check);
    const accountSummary = yield* DataQuality.GetDataQualitySummary();
    const catalogSummary = yield* DataQuality.GetCatalogDataQualitySummary(BindingsWarehouse);
    const schemaSummary = yield* DataQuality.GetCatalogSchemaDataQualitySummary(BindingsWarehouse);
    const tableSummary =
      yield* DataQuality.GetCatalogSchemaTableDataQualitySummary(BindingsWarehouse);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");

        if (url.pathname === "/evaluate") {
          yield* evaluate();
          return yield* HttpServerResponse.json({ requested: true });
        }
        if (url.pathname === "/latest") {
          const found = yield* latest();
          return yield* HttpServerResponse.json({
            dataQualityCheckId: found.dataQualityCheckId,
            evaluatedAt: found.latestEvaluation?.evaluatedAt ?? null,
            status: found.latestEvaluation?.status ?? null,
          });
        }
        if (url.pathname === "/evaluations") {
          const found = yield* evaluations();
          return yield* HttpServerResponse.json({
            statuses: found.evaluations.map((evaluation) => evaluation.status),
          });
        }
        if (url.pathname === "/summary") {
          const table = { schemaName: "sales", tableName: "orders" };
          const account = yield* accountSummary();
          const catalog = yield* catalogSummary();
          const schema = yield* schemaSummary({ schemaName: "sales" });
          const orders = yield* tableSummary(table);
          return yield* HttpServerResponse.json({
            account: account.severityCounts.length,
            catalog: catalog.severityCounts.length,
            schema: schema.severityCounts.length,
            checks: orders.qualityCheckSummaries.map((summary) => summary.dataQualityCheckId),
          });
        }
        return HttpServerResponse.text("not found", { status: 404 });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 500 })),
        ),
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        DataQuality.EvaluateDataQualityCheckHttp,
        DataQuality.GetLatestDataQualityCheckEvaluationHttp,
        DataQuality.GetDataQualityCheckEvaluationsHttp,
        DataQuality.GetDataQualitySummaryHttp,
        DataQuality.GetCatalogDataQualitySummaryHttp,
        DataQuality.GetCatalogSchemaDataQualitySummaryHttp,
        DataQuality.GetCatalogSchemaTableDataQualitySummaryHttp,
      ),
    ),
  ),
) {}
