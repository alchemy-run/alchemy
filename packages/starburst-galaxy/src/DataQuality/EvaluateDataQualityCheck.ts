import type * as dataQuality from "@distilled.cloud/starburst-galaxy/data_quality";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { DataQualityCheck } from "./DataQualityCheck.ts";

/** What `evaluateDataQualityCheck` takes. */
export interface EvaluateDataQualityCheckRequest {
  /** Cluster that runs a SQL check, when it differs from the check's. */
  readonly clusterId?: string;
}

/**
 * Start an evaluation of the bound data quality check now. Galaxy
 * evaluates it asynchronously: read the result with
 * `GetLatestDataQualityCheckEvaluation`.
 *
 * The host calls Galaxy as the deploying profile's API client: Galaxy
 * can't mint a key per host or trust a host's identity (see
 * `StarburstGalaxyBindings`), so the client's role bounds what the host
 * may do.
 *
 * ### Calling it from a Worker
 * **Example:** EvaluateDataQualityCheck
 * ```typescript
 * const shop = StarburstGalaxy.Catalog.PostgresqlCatalog.lookup({ name: "shop" });
 * export const OrdersPresent = StarburstGalaxy.DataQuality.DataQualityCheck("OrdersPresent", {
 *   catalogId: shop.catalogId,
 *   schemaName: "sales",
 *   tableName: "orders",
 *   kind: "QualityExpression",
 *   query: "row_count_min(1)",
 *   severity: "High",
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const evaluateDataQualityCheck = yield* StarburstGalaxy.DataQuality.EvaluateDataQualityCheck(OrdersPresent);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* evaluateDataQualityCheck();
 *         return yield* HttpServerResponse.json("started");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(StarburstGalaxy.DataQuality.EvaluateDataQualityCheckHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product DataQuality
 */
export interface EvaluateDataQualityCheck extends Binding.Service<
  EvaluateDataQualityCheck,
  "StarburstGalaxy.DataQuality.EvaluateDataQualityCheck",
  (
    check: DataQualityCheck,
  ) => Effect.Effect<
    (
      request?: EvaluateDataQualityCheckRequest,
    ) => Effect.Effect<void, dataQuality.EvaluateDataQualityCheckError, RuntimeContext>
  >
> {}

export const EvaluateDataQualityCheck = Binding.Service<EvaluateDataQualityCheck>(
  "StarburstGalaxy.DataQuality.EvaluateDataQualityCheck",
);
