import type * as dataQuality from "@distilled.cloud/starburst-galaxy/data_quality";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { DataQualityCheck } from "./DataQualityCheck.ts";

/**
 * Read the bound check with its latest evaluation, if it has run: the
 * result to poll after `EvaluateDataQualityCheck`.
 *
 * The host calls Galaxy as the deploying profile's API client: Galaxy
 * can't mint a key per host or trust a host's identity (see
 * `StarburstGalaxyBindings`), so the client's role bounds what the host
 * may do.
 *
 * ### Calling it from a Worker
 * **Example:** GetLatestDataQualityCheckEvaluation
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
 *     const getLatestDataQualityCheckEvaluation = yield* StarburstGalaxy.DataQuality.GetLatestDataQualityCheckEvaluation(OrdersPresent);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const latest = yield* getLatestDataQualityCheckEvaluation();
 *         return yield* HttpServerResponse.json(latest.latestEvaluation?.status);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(StarburstGalaxy.DataQuality.GetLatestDataQualityCheckEvaluationHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product DataQuality
 */
export interface GetLatestDataQualityCheckEvaluation extends Binding.Service<
  GetLatestDataQualityCheckEvaluation,
  "StarburstGalaxy.DataQuality.GetLatestDataQualityCheckEvaluation",
  (
    check: DataQualityCheck,
  ) => Effect.Effect<
    () => Effect.Effect<
      dataQuality.DataQualityCheckWithEvaluation,
      dataQuality.GetLatestDataQualityCheckEvaluationError,
      RuntimeContext
    >
  >
> {}

export const GetLatestDataQualityCheckEvaluation =
  Binding.Service<GetLatestDataQualityCheckEvaluation>(
    "StarburstGalaxy.DataQuality.GetLatestDataQualityCheckEvaluation",
  );
